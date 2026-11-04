'use strict';

// Mondes d'une instance : liste, sauvegardes .zip (dans .0rzxn\backups\<instance>) et restauration.
// Une restauration n'écrase jamais rien : extraction dans un dossier temporaire, puis renommage.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { freeWorldFolder, listFiles, readWorld, scanWorlds } = require('./importer');
const { exists, readJson, writeJson } = require('./store');
const zip = require('./zip');

const skipLock = (rel) => path.basename(rel) === 'session.lock';
const savesOf = (gameDir) => path.join(gameDir, 'saves');

/** Nom de dossier de monde reçu de l'interface : un seul segment, jamais un chemin. */
function worldDir(gameDir, folder) {
  if (typeof folder !== 'string' || !folder || folder !== path.basename(folder) || folder === '.' || folder === '..') throw new Error('Monde invalide.');
  const dir = path.join(savesOf(gameDir), folder);
  if (!exists(path.join(dir, 'level.dat'))) throw new Error('Ce monde n’existe plus.');
  return dir;
}

async function folderSize(dir) {
  const files = await listFiles(dir);
  const sizes = await Promise.all(files.map((rel) => fsp.stat(path.join(dir, rel)).then((s) => s.size, () => 0)));
  return sizes.reduce((sum, n) => sum + n, 0);
}

/** Mondes du dossier saves, du plus récemment joué au plus ancien. */
async function listWorlds(gameDir) {
  const worlds = scanWorlds(savesOf(gameDir)).filter((w) => !w.folder.startsWith('.restauration-'));
  return Promise.all(
    worlds.map(async ({ path: dir, ...world }) => ({ ...world, size: await folderSize(dir).catch(() => null) })),
  );
}

// ---------- Sauvegardes ----------

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
const STAMPED = /^(.+)_(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)(?:-\d+)?\.zip$/;
const indexFile = (backupDir) => path.join(backupDir, 'index.json');

/** Nom de fichier d'une sauvegarde reçu de l'interface. */
function backupFile(backupDir, file) {
  if (typeof file !== 'string' || file !== path.basename(file) || !file.toLowerCase().endsWith('.zip')) throw new Error('Sauvegarde invalide.');
  const full = path.join(backupDir, file);
  if (!exists(full)) throw new Error('Cette sauvegarde n’existe plus.');
  return full;
}

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
      const folder = m ? m[1] : file.replace(/\.zip$/i, '');
      return { file, folder, name: index[file]?.name ?? folder, createdAt, size: stat.size };
    }),
  );
  return items.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}

/** Archive un monde : « <dossier>/… » à la racine du .zip, comme la sauvegarde intégrée du jeu. */
async function backupWorld({ gameDir, folder, backupDir, signal, onProgress }) {
  const dir = worldDir(gameDir, folder);
  const world = readWorld(dir);
  const files = await listFiles(dir, skipLock);
  await fsp.mkdir(backupDir, { recursive: true });
  const base = `${folder}_${stamp(new Date())}`;
  let file = `${base}.zip`;
  for (let n = 2; exists(path.join(backupDir, file)); n++) file = `${base}-${n}.zip`;
  const result = await zip.writeZipFile(
    path.join(backupDir, file),
    files.map((rel) => ({ name: `${folder}/${rel.split(path.sep).join('/')}`, path: path.join(dir, rel) })),
    { signal, onProgress },
  );
  const index = readJson(indexFile(backupDir), {});
  index[file] = { name: world?.name ?? folder, folder };
  writeJson(indexFile(backupDir), index);
  return { file, name: world?.name ?? folder, size: result.size, files: result.files };
}

async function forgetBackup(backupDir, file) {
  const index = readJson(indexFile(backupDir), {});
  if (!(file in index)) return;
  delete index[file];
  writeJson(indexFile(backupDir), index);
}

// ---------- Restauration ----------

/** Nom de fichier valide sous Windows. */
function safeFolderName(name) {
  const clean = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  return clean && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean) ? clean.slice(0, 80) : 'Monde restauré';
}

/** Dossier du monde dans l'archive : celui du level.dat le moins profond. Chaque chemin est vérifié (pas de « .. »). */
function worldLayout(entries, zipFile) {
  const files = [];
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/');
    if (name.endsWith('/')) continue;
    const parts = name.split('/');
    if (parts.some((p) => !p || p === '.' || p === '..' || p.includes(':'))) throw new Error(`Chemin refusé dans l’archive : ${entry.name}`);
    files.push({ entry, parts });
  }
  const levels = files.filter((f) => f.parts[f.parts.length - 1] === 'level.dat').sort((a, b) => a.parts.length - b.parts.length);
  if (!levels.length) throw new Error('Cette archive ne contient pas de monde Minecraft (level.dat introuvable).');
  const prefix = levels[0].parts.slice(0, -1);
  const inside = files.filter((f) => prefix.every((p, i) => f.parts[i] === p) && f.parts.length > prefix.length);
  const fromFile = STAMPED.exec(path.basename(zipFile))?.[1] ?? path.basename(zipFile).replace(/\.zip$/i, '');
  return {
    folder: safeFolderName(prefix.length ? prefix[prefix.length - 1] : fromFile),
    files: inside.map((f) => ({ entry: f.entry, rel: f.parts.slice(prefix.length) })).filter((f) => f.rel[f.rel.length - 1] !== 'session.lock'),
  };
}

/** Monde contenu dans un .zip, et si un dossier du même nom existe déjà dans l'instance. */
async function inspectArchive(zipFile, gameDir) {
  const archive = await zip.openZipFile(zipFile);
  try {
    const { folder, files } = worldLayout(archive.entries, zipFile);
    return { folder, files: files.length, taken: exists(path.join(savesOf(gameDir), folder)) };
  } finally {
    await archive.close();
  }
}

/**
 * Restaure un monde depuis un .zip. Si un dossier du même nom existe et que `mode` n'est pas donné,
 * renvoie { conflict } sans rien écrire. mode : 'beside' (nouveau dossier) ou 'replace' (l'actuel va à la corbeille).
 */
async function restoreWorld({ zipFile, gameDir, mode = null, trash, signal, onProgress }) {
  const archive = await zip.openZipFile(zipFile);
  const saves = savesOf(gameDir);
  const temp = path.join(saves, `.restauration-${crypto.randomBytes(4).toString('hex')}`);
  try {
    const { folder, files } = worldLayout(archive.entries, zipFile);
    const taken = exists(path.join(saves, folder));
    if (taken && mode !== 'beside' && mode !== 'replace') return { conflict: true, folder };

    await fsp.mkdir(temp, { recursive: true });
    let done = 0;
    let last = 0;
    onProgress?.({ done, total: files.length });
    for (const { entry, rel } of files) {
      if (signal?.aborted) throw new Error('Restauration annulée.');
      const target = path.join(temp, ...rel);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, await archive.read(entry), { flag: 'wx' });
      done++;
      if (done === files.length || Date.now() - last > 100) {
        last = Date.now();
        onProgress?.({ done, total: files.length });
      }
    }
    const world = readWorld(temp);
    if (!world) throw new Error('Le level.dat de cette archive est illisible : rien n’a été restauré.');

    const replaced = taken && mode === 'replace';
    const finalFolder = replaced || !taken ? folder : freeWorldFolder(saves, folder);
    if (replaced) await trash(path.join(saves, folder));
    await fsp.rename(temp, path.join(saves, finalFolder));
    return { folder: finalFolder, name: world.name, replaced, files: files.length };
  } catch (error) {
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await archive.close();
  }
}

module.exports = { listWorlds, worldDir, listBackups, backupFile, backupWorld, forgetBackup, inspectArchive, restoreWorld };
