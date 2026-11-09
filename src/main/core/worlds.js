'use strict';

// Mondes d'une instance : lecture de level.dat, sauvegardes .zip (dans backups\<instance>), rotation des
// sauvegardes automatiques et restauration. Une restauration n'écrase jamais rien : extraction dans un dossier
// temporaire, puis renommage ; un monde remplacé part dans la corbeille.
const { t } = require('../i18n');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const nbt = require('./nbt');
const { listFiles } = require('./importer');
const { exists, readJson, writeJson } = require('./store');
const zip = require('./zip');

const GAME_TYPES = ['survival', 'creative', 'adventure', 'spectator'];
const REASONS = new Set(['manual', 'modpack', 'version', 'loader', 'launch']);
const TEMP_PREFIX = '.restauration-';
// Déjà compressés (régions, images, archives) : rangés tels quels, la sauvegarde va bien plus vite.
const PRECOMPRESSED = /\.(mca|mcc|png|jpg|zip|jar|gz)$/i;
const skipLock = (rel) => path.basename(rel) === 'session.lock';
const savesOf = (gameDir) => path.join(gameDir, 'saves');
const stripFormatting = (value) => String(value ?? '').replace(/§./g, '');

/** Lit un monde (dossier avec level.dat). Renvoie null si ce n'est pas un monde lisible. */
function readWorld(dir) {
  let data;
  try {
    data = nbt.get(nbt.parse(fs.readFileSync(path.join(dir, 'level.dat'))), 'Data');
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const version = nbt.get(data, 'Version');
  const lastPlayed = nbt.get(data, 'LastPlayed');
  const gameType = nbt.get(data, 'GameType');
  let icon = null;
  try {
    const png = fs.readFileSync(path.join(dir, 'icon.png'));
    if (png.length < 256 * 1024 && png.subarray(1, 4).toString() === 'PNG') icon = `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    // pas d'icône
  }
  return {
    folder: path.basename(dir),
    name: stripFormatting(nbt.get(data, 'LevelName')) || path.basename(dir),
    version: Array.isArray(version) ? (nbt.get(version, 'Name') ?? null) : null,
    lastPlayed: typeof lastPlayed === 'bigint' ? Number(lastPlayed) : null,
    hardcore: nbt.get(data, 'hardcore') === 1,
    mode: GAME_TYPES[gameType] ?? null,
    icon,
  };
}

/** Nom de dossier de monde reçu de l'interface : un seul segment, jamais un chemin. */
function worldDir(gameDir, folder) {
  if (typeof folder !== 'string' || !folder || folder !== path.basename(folder) || folder === '.' || folder === '..' || folder.startsWith(TEMP_PREFIX)) {
    throw new Error(t('worlds.monde_invalide'));
  }
  const dir = path.join(savesOf(gameDir), folder);
  if (!exists(path.join(dir, 'level.dat'))) throw new Error(t('worlds.monde_introuvable'));
  return dir;
}

async function folderSize(dir) {
  const files = await listFiles(dir);
  const sizes = await Promise.all(files.map((rel) => fsp.stat(path.join(dir, rel)).then((s) => s.size, () => 0)));
  return sizes.reduce((sum, n) => sum + n, 0);
}

/** Dossiers de mondes du dossier saves (sans lire leur taille). */
function scanWorlds(gameDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(savesOf(gameDir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(TEMP_PREFIX))
    .map((e) => readWorld(path.join(savesOf(gameDir), e.name)))
    .filter(Boolean)
    .sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0));
}

/** Mondes du dossier saves avec leur taille, du plus récemment joué au plus ancien. */
async function listWorlds(gameDir) {
  return Promise.all(
    scanWorlds(gameDir).map(async (world) => ({ ...world, size: await folderSize(path.join(savesOf(gameDir), world.folder)).catch(() => null) })),
  );
}

// ---------- Sauvegardes ----------

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
const STAMPED = /^(.+)_(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)(?:-\d+)?\.zip$/;
const indexFile = (backupDir) => path.join(backupDir, 'index.json');

/** Nom de fichier d'une sauvegarde reçu de l'interface. */
function backupFile(backupDir, file) {
  if (typeof file !== 'string' || file !== path.basename(file) || !file.toLowerCase().endsWith('.zip')) throw new Error(t('worlds.sauvegarde_invalide'));
  const full = path.join(backupDir, file);
  if (!exists(full)) throw new Error(t('worlds.sauvegarde_introuvable'));
  return full;
}

/** Sauvegardes d'une instance, les plus récentes d'abord. `kind` : 'auto' ou 'manual' ; `reason` : pourquoi elle a été faite. */
async function listBackups(backupDir) {
  let names = [];
  try {
    names = (await fsp.readdir(backupDir)).filter((n) => n.toLowerCase().endsWith('.zip'));
  } catch {
    return [];
  }
  const index = readJson(indexFile(backupDir), {});
  const items = await Promise.all(
    names.map(async (file) => {
      const stat = await fsp.stat(path.join(backupDir, file)).catch(() => null);
      if (!stat?.isFile()) return null;
      const m = STAMPED.exec(file);
      const createdAt = m ? new Date(+m[2], m[3] - 1, +m[4], +m[5], +m[6], +m[7]).getTime() : stat.mtimeMs;
      const meta = index[file] ?? {};
      const folder = meta.folder ?? (m ? m[1] : file.replace(/\.zip$/i, ''));
      const reason = REASONS.has(meta.reason) ? meta.reason : 'manual';
      return { file, folder, name: meta.name ?? folder, createdAt, size: stat.size, kind: meta.kind === 'auto' ? 'auto' : 'manual', reason };
    }),
  );
  return items.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}

/** Place libre sur le disque du dossier (null si inconnue). */
async function freeSpace(dir) {
  try {
    const s = await fsp.statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

function noSpace(name, free, needed) {
  return Object.assign(new Error(t('worlds.pas_assez_de_place', { name, free: gb(free), needed: gb(needed) })), { code: 'NO_SPACE' });
}
const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1);

/** Archive un dossier de monde déjà listé. `onFile` est appelé après chaque fichier. */
async function archive({ dir, folder, name, files, backupDir, kind, reason, signal, onFile }) {
  await fsp.mkdir(backupDir, { recursive: true });
  const base = `${folder}_${stamp(new Date())}`;
  let file = `${base}.zip`;
  for (let n = 2; exists(path.join(backupDir, file)); n++) file = `${base}-${n}.zip`;
  const result = await zip.writeZipFile(
    path.join(backupDir, file),
    files.map((rel) => ({ name: `${folder}/${rel.split(path.sep).join('/')}`, path: path.join(dir, rel), store: PRECOMPRESSED.test(rel) })),
    { signal, onProgress: onFile },
  );
  const index = readJson(indexFile(backupDir), {});
  index[file] = { name, folder, kind, reason };
  writeJson(indexFile(backupDir), index);
  return { file, name, folder, size: result.size, files: result.files };
}

/** Sauvegarde un monde (à la main par défaut). */
async function backupWorld({ gameDir, folder, backupDir, kind = 'manual', reason = 'manual', signal, onProgress }) {
  const dir = worldDir(gameDir, folder);
  const world = readWorld(dir);
  const files = await listFiles(dir, skipLock);
  const needed = (await folderSize(dir)) * 1.05;
  await fsp.mkdir(backupDir, { recursive: true });
  const free = await freeSpace(backupDir);
  if (free !== null && free < needed) throw noSpace(world?.name ?? folder, free, needed);
  return archive({ dir, folder, name: world?.name ?? folder, files, backupDir, kind, reason, signal, onFile: onProgress });
}

/**
 * Sauvegarde automatique de plusieurs mondes (tous par défaut, ou ceux que `filter` garde), puis rotation :
 * seules les `keep` dernières sauvegardes automatiques de chaque monde restent, les autres vont à la corbeille.
 * Renvoie { worlds: [...], skipped } ; rien n'est écrit si la place manque.
 */
async function backupAll({ gameDir, backupDir, reason, keep, trash, filter = () => true, signal, onProgress }) {
  const worlds = scanWorlds(gameDir).filter(filter);
  const plans = await Promise.all(
    worlds.map(async (world) => {
      const dir = path.join(savesOf(gameDir), world.folder);
      const files = await listFiles(dir, skipLock);
      return { world, dir, files, size: await folderSize(dir) };
    }),
  );
  const total = plans.reduce((n, p) => n + p.files.length, 0);
  if (!total) return { worlds: [] };
  await fsp.mkdir(backupDir, { recursive: true });
  const needed = plans.reduce((n, p) => n + p.size, 0) * 1.05;
  const free = await freeSpace(backupDir);
  if (free !== null && free < needed) throw noSpace(plans.map((p) => p.world.name).join(', '), free, needed);

  const done = [];
  let before = 0;
  onProgress?.({ done: 0, total });
  for (const plan of plans) {
    const result = await archive({
      dir: plan.dir, folder: plan.world.folder, name: plan.world.name, files: plan.files, backupDir, kind: 'auto', reason, signal,
      onFile: (p) => onProgress?.({ done: before + p.done, total, world: plan.world.name }),
    });
    before += plan.files.length;
    done.push(result);
  }
  await pruneAuto({ backupDir, keep, trash, folders: plans.map((p) => p.world.folder) });
  return { worlds: done };
}

/** Rotation : au-delà de `keep` sauvegardes automatiques par monde, les plus anciennes vont à la corbeille. */
async function pruneAuto({ backupDir, keep, trash, folders = null }) {
  const limit = Math.max(1, Math.min(50, Math.round(Number(keep) || 5)));
  const backups = (await listBackups(backupDir)).filter((b) => b.kind === 'auto' && (!folders || folders.includes(b.folder)));
  const seen = new Map();
  const removed = [];
  for (const b of backups) {
    const n = (seen.get(b.folder) ?? 0) + 1;
    seen.set(b.folder, n);
    if (n > limit) {
      await trash(path.join(backupDir, b.file));
      removed.push(b.file);
    }
  }
  if (removed.length) await forget(backupDir, removed);
  return removed;
}

async function forget(backupDir, files) {
  const index = readJson(indexFile(backupDir), {});
  for (const file of files) delete index[file];
  writeJson(indexFile(backupDir), index);
}

/** Met une sauvegarde à la corbeille. */
async function deleteBackup({ backupDir, file, trash }) {
  await trash(backupFile(backupDir, file));
  await forget(backupDir, [file]);
}

/** Met un monde à la corbeille. */
async function deleteWorld({ gameDir, folder, trash }) {
  await trash(worldDir(gameDir, folder));
}

// ---------- Restauration ----------

/** Nom de dossier valide sous Windows. */
function safeFolderName(name) {
  // eslint-disable-next-line no-control-regex
  const clean = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  return clean && !clean.startsWith(TEMP_PREFIX) && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean) ? clean.slice(0, 80) : 'World';
}

/** Nom de dossier libre dans saves (« Survie », « Survie (2) »…), comme le fait le jeu. */
function freeWorldFolder(saves, folder) {
  let name = folder;
  for (let n = 2; fs.existsSync(path.join(saves, name)); n++) name = `${folder} (${n})`;
  return name;
}

/** Dossier du monde dans l'archive : celui du level.dat le moins profond. Chaque chemin est vérifié (pas de « .. »). */
function worldLayout(entries, zipFile) {
  const files = [];
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/');
    if (name.endsWith('/')) continue;
    const parts = name.split('/');
    if (parts.some((p) => !p || p === '.' || p === '..' || p.includes(':'))) throw new Error(t('worlds.chemin_refuse', { name: entry.name }));
    files.push({ entry, parts });
  }
  const levels = files.filter((f) => f.parts[f.parts.length - 1] === 'level.dat').sort((a, b) => a.parts.length - b.parts.length);
  if (!levels.length) throw new Error(t('worlds.archive_sans_monde'));
  const prefix = levels[0].parts.slice(0, -1);
  const inside = files.filter((f) => prefix.every((p, i) => f.parts[i] === p) && f.parts.length > prefix.length);
  const fromFile = STAMPED.exec(path.basename(zipFile))?.[1] ?? path.basename(zipFile).replace(/\.zip$/i, '');
  return {
    folder: safeFolderName(prefix.length ? prefix[prefix.length - 1] : fromFile),
    files: inside.map((f) => ({ entry: f.entry, rel: f.parts.slice(prefix.length) })).filter((f) => f.rel[f.rel.length - 1] !== 'session.lock'),
  };
}

/**
 * Restaure un monde depuis un .zip. mode : 'beside' (nouveau dossier à côté, par défaut) ou 'replace'
 * (le monde du même nom va à la corbeille, seulement une fois la copie complète et lisible).
 */
async function restoreWorld({ zipFile, gameDir, mode = 'beside', trash, signal, onProgress }) {
  const archiveFile = await zip.openZipFile(zipFile);
  const saves = savesOf(gameDir);
  const temp = path.join(saves, `${TEMP_PREFIX}${crypto.randomBytes(4).toString('hex')}`);
  try {
    const { folder, files } = worldLayout(archiveFile.entries, zipFile);
    await fsp.mkdir(temp, { recursive: true });
    let done = 0;
    let last = 0;
    onProgress?.({ done, total: files.length });
    for (const { entry, rel } of files) {
      if (signal?.aborted) throw new Error(t('worlds.restauration_annulee'));
      const target = path.join(temp, ...rel);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, await archiveFile.read(entry), { flag: 'wx' });
      done++;
      if (done === files.length || Date.now() - last > 100) {
        last = Date.now();
        onProgress?.({ done, total: files.length });
      }
    }
    const world = readWorld(temp);
    if (!world) throw new Error(t('worlds.level_dat_illisible'));

    const taken = exists(path.join(saves, folder));
    const replaced = taken && mode === 'replace';
    const finalFolder = replaced || !taken ? folder : freeWorldFolder(saves, folder);
    if (replaced) await trash(path.join(saves, folder));
    await fsp.rename(temp, path.join(saves, finalFolder));
    return { folder: finalFolder, name: world.name, replaced, files: files.length };
  } catch (error) {
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await archiveFile.close();
  }
}

module.exports = {
  readWorld, scanWorlds, listWorlds, worldDir,
  listBackups, backupFile, backupWorld, backupAll, pruneAuto, deleteBackup, deleteWorld,
  restoreWorld, freeWorldFolder,
};
