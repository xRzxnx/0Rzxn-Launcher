'use strict';

// Import depuis d'autres launchers : instances rangées dans un dossier avec instance.cfg et mmc-pack.json
// (copie du dossier du jeu, loader,
// réglages, temps de jeu) et mondes d'un dossier .minecraft. La source est seulement lue, jamais modifiée.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const nbt = require('./nbt');
const { exists, readJson } = require('./store');
const { resolveLoaderVersion } = require('./loaders');

// ---------- Copie avec progression ----------

/** Liste les fichiers d'un dossier (chemins relatifs). Les liens symboliques sont ignorés : on ne sort jamais de la source. */
async function listFiles(root, skip = () => false) {
  const files = [];
  const walk = async (rel) => {
    const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(rel, entry.name);
      if (skip(child, entry)) continue;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  await walk('');
  return files;
}

/** Copie `src` dans `dest` (qui ne doit pas exister), fichier par fichier, avec { done, total }. */
async function copyTree(src, dest, { skip, onProgress, signal } = {}) {
  const files = await listFiles(src, skip);
  const total = files.length;
  let done = 0;
  let last = 0;
  onProgress?.({ done, total });
  await fsp.mkdir(dest, { recursive: true });
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      if (signal?.aborted) throw new Error('Import annulé.');
      const rel = files[next++];
      const target = path.join(dest, rel);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(path.join(src, rel), target, fs.constants.COPYFILE_EXCL);
      done++;
      // Pas un message par fichier : une instance moddée en compte des milliers.
      if (done === total || Date.now() - last > 100) {
        last = Date.now();
        onProgress?.({ done, total });
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return total;
}

// ---------- Instances d'autres launchers (instance.cfg + mmc-pack.json) ----------

/** instance.cfg : INI (section [General]) écrit par l'autre launcher, valeurs parfois entre guillemets et échappées. */
function parseCfg(textContent) {
  const values = {};
  let section = 'General';
  for (const raw of textContent.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    if (section !== 'General') continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    values[line.slice(0, eq).trim()] = value.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r' })[c] ?? c);
  }
  return values;
}

const isTrue = (value) => value === 'true';

const LOADER_UIDS = {
  'net.fabricmc.fabric-loader': 'fabric',
  'org.quiltmc.quilt-loader': 'quilt',
  'net.minecraftforge': 'forge',
  'net.neoforged': 'neoforge',
};
// Composants gérés automatiquement par notre launcher (bibliothèques et mappings du loader).
const BUILT_IN_UIDS = new Set(['net.minecraft', 'org.lwjgl', 'org.lwjgl3', 'net.fabricmc.intermediary', 'org.quiltmc.hashed']);

/** Icônes de l'autre launcher → nos icônes de blocs (les icônes personnalisées deviennent de l'herbe). */
function iconOf(key = '') {
  const k = key.toLowerCase();
  if (k.includes('diamond')) return 'diamond';
  if (/stone|cobble|iron|gold|brick/.test(k)) return 'stone';
  if (/nether|flame|fire|magma/.test(k)) return 'netherrack';
  if (k.includes('sand')) return 'sand';
  if (/ender|end_|^end$/.test(k)) return 'end';
  return 'grass';
}

/** Libellé de la source affiché dans la fenêtre « Importer » : on décrit le dossier sans nommer le launcher d'origine. */
function launcherName() {
  return 'Autre launcher';
}

/** Groupe de chaque instance (instgroups.json), par nom de dossier. */
function readGroups(instancesDir) {
  const groups = readJson(path.join(instancesDir, 'instgroups.json'), null)?.groups ?? {};
  const byFolder = {};
  for (const [name, group] of Object.entries(groups)) for (const folder of group?.instances ?? []) byFolder[folder] = name;
  return byFolder;
}

/** Lit une instance d'un autre launcher sans rien modifier. `supported` est faux si on ne sait pas la reprendre. */
function readInstance(dir, groups = {}) {
  const cfg = parseCfg(fs.readFileSync(path.join(dir, 'instance.cfg'), 'utf8'));
  const pack = readJson(path.join(dir, 'mmc-pack.json'), null);
  const components = Array.isArray(pack?.components) ? pack.components : [];
  const warnings = [];
  let problem = null;

  const version = components.find((c) => c.uid === 'net.minecraft')?.version ?? null;
  const loaders = components.filter((c) => LOADER_UIDS[c.uid]);
  const loader = loaders[0] ? LOADER_UIDS[loaders[0].uid] : 'vanilla';
  for (const c of components) {
    if (BUILT_IN_UIDS.has(c.uid) || LOADER_UIDS[c.uid]) continue;
    warnings.push(`Composant non repris : ${c.cachedName || c.uid}`);
  }
  if (cfg.InstanceType && cfg.InstanceType !== 'OneSix') problem = "Ancien format d'instance (Legacy), non pris en charge.";
  else if (!version) problem = 'Version de Minecraft introuvable dans mmc-pack.json.';
  else if (loaders.length > 1) problem = 'Plusieurs loaders de mods dans la même instance.';
  else if (loader !== 'vanilla' && !loaders[0].version) problem = 'Version du loader introuvable.';
  if (fs.existsSync(path.join(dir, 'jarmods')) && fs.readdirSync(path.join(dir, 'jarmods')).length) warnings.push('Les « jar mods » ne sont pas repris.');

  const gameDir = ['minecraft', '.minecraft'].map((name) => path.join(dir, name)).find((p) => fs.existsSync(p)) ?? null;
  const seconds = Number(cfg.totalTimePlayed);
  const lastLaunch = Number(cfg.lastLaunchTime);
  return {
    path: dir,
    folder: path.basename(dir),
    name: (cfg.name || path.basename(dir)).trim(),
    icon: iconOf(cfg.iconKey),
    group: groups[path.basename(dir)] ?? null,
    version,
    loader,
    loaderVersion: loader === 'vanilla' ? null : loaders[0].version,
    playtime: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds / 60) : 0,
    lastPlayedAt: Number.isFinite(lastLaunch) && lastLaunch > 0 ? lastLaunch : null,
    settings: settingsOf(cfg),
    hasGameDir: Boolean(gameDir),
    warnings,
    problem,
    supported: !problem,
  };
}

/** Réglages propres à l'instance (seulement ceux que l'autre launcher marque comme « remplacés »). */
function settingsOf(cfg) {
  const s = {};
  const mb = Number(cfg.MaxMemAlloc);
  if (isTrue(cfg.OverrideMemory) && mb > 0) s.ram = Math.max(0.5, Math.round((mb / 1024) * 2) / 2);
  // Java choisi automatiquement par l'autre launcher (AutomaticJava) : on laisse notre launcher choisir le sien.
  const javaPath = cfg.JavaPath?.replace(/\//g, path.sep);
  if ((isTrue(cfg.OverrideJavaLocation) || isTrue(cfg.OverrideJava)) && !isTrue(cfg.AutomaticJava) && javaPath && exists(javaPath)) {
    s.java = 'custom';
    s.javaPath = javaPath;
  }
  if ((isTrue(cfg.OverrideJavaArgs) || isTrue(cfg.OverrideJava)) && cfg.JvmArgs) s.jvmArgs = cfg.JvmArgs;
  const width = Number(cfg.MinecraftWinWidth);
  const height = Number(cfg.MinecraftWinHeight);
  if (isTrue(cfg.OverrideWindow) && Number.isInteger(width) && Number.isInteger(height)) Object.assign(s, { width, height });
  return s;
}

/**
 * Dossier d'instances par défaut : celui du launcher compatible le plus courant s'il est installé
 * (réglage InstanceDir de son fichier .cfg, sinon « instances »). Les deux noms ci-dessous sont
 * ceux de ses fichiers sur le disque, nécessaires pour le trouver.
 */
function defaultInstancesDir(appData) {
  const root = path.join(appData, 'PrismLauncher');
  let dir = 'instances';
  try {
    const line = fs.readFileSync(path.join(root, 'prismlauncher.cfg'), 'utf8').split(/\r?\n/).find((l) => l.startsWith('InstanceDir='));
    if (line) dir = line.slice('InstanceDir='.length).trim().replace(/^"|"$/g, '') || dir;
  } catch {
    // aucun launcher compatible installé
  }
  return path.resolve(root, dir);
}

/**
 * Instances d'un dossier : soit un dossier d'instances, soit une seule instance.
 * Renvoie { launcher, dir, instances } ; instances vide si rien n'est reconnu.
 */
function scanInstances(dir) {
  if (exists(path.join(dir, 'instance.cfg'))) {
    const parent = path.dirname(dir);
    return { launcher: launcherName(parent), dir, instances: [safeRead(dir, readGroups(parent))].filter(Boolean) };
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { launcher: null, dir, instances: [] };
  }
  const groups = readGroups(dir);
  const list = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && exists(path.join(dir, e.name, 'instance.cfg')))
    .map((e) => safeRead(path.join(dir, e.name), groups))
    .filter(Boolean)
    .sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0));
  return { launcher: launcherName(dir), dir, instances: list };
}

function safeRead(dir, groups) {
  try {
    return readInstance(dir, groups);
  } catch {
    return null;
  }
}

/** Crée une nouvelle instance à partir d'une instance d'un autre launcher (copie complète de son dossier du jeu). */
async function importInstance({ instances, dir, defaults, launcher = 'Autre launcher', signal, onProgress }) {
  const source = readInstance(dir, readGroups(path.dirname(dir)));
  if (!source.supported) throw new Error(source.problem);
  const loaderVersion = source.loader === 'vanilla' ? null : await resolveLoaderVersion(source.loader, source.version, source.loaderVersion);
  const instance = instances.create(
    { name: source.name, icon: source.icon, version: source.version, loader: source.loader, loaderVersion, group: source.group },
    defaults,
  );
  let files = 0;
  try {
    if (Object.keys(source.settings).length) instances.update(instance.id, { settings: source.settings });
    if (source.hasGameDir) {
      const from = ['minecraft', '.minecraft'].map((name) => path.join(dir, name)).find((p) => fs.existsSync(p));
      const target = instances.gameDir(instance.id);
      await fsp.rm(target, { recursive: true, force: true }); // dossier vide créé par create()
      files = await copyTree(from, target, { signal, onProgress, skip: (rel) => path.basename(rel) === 'session.lock' });
    }
    instances.markImported(instance.id, {
      from: { launcher, path: dir, name: source.name },
      playtime: source.playtime,
      lastPlayedAt: source.lastPlayedAt,
    });
  } catch (error) {
    // Instance incomplète : on la retire (elle vient d'être créée). La source n'est jamais touchée.
    await fsp.rm(instances.dir(instance.id), { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { instance: instances.get(instance.id), files, warnings: source.warnings };
}

// ---------- Mondes ----------

const stripFormatting = (value) => String(value ?? '').replace(/§./g, '');

/** Lit un monde (dossier avec level.dat). Renvoie null si ce n'est pas un monde lisible. */
function readWorld(dir) {
  let data;
  try {
    data = nbt.get(nbt.parse(fs.readFileSync(path.join(dir, 'level.dat'))).value, 'Data');
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const version = nbt.get(data, 'Version');
  const lastPlayed = nbt.get(data, 'LastPlayed');
  let icon = null;
  try {
    const png = fs.readFileSync(path.join(dir, 'icon.png'));
    if (png.length < 256 * 1024) icon = `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    // pas d'icône
  }
  return {
    path: dir,
    folder: path.basename(dir),
    name: stripFormatting(nbt.get(data, 'LevelName')) || path.basename(dir),
    version: Array.isArray(version) ? nbt.get(version, 'Name') ?? null : null,
    lastPlayed: typeof lastPlayed === 'bigint' ? Number(lastPlayed) : null,
    hardcore: nbt.get(data, 'hardcore') === 1,
    gameType: nbt.get(data, 'GameType') ?? null,
    icon,
  };
}

/** Mondes d'un dossier : un dossier du jeu (avec saves), un dossier saves, ou un seul monde. */
function scanWorlds(dir) {
  if (exists(path.join(dir, 'level.dat'))) return [readWorld(dir)].filter(Boolean);
  const saves = exists(path.join(dir, 'saves')) ? path.join(dir, 'saves') : dir;
  let entries = [];
  try {
    entries = fs.readdirSync(saves, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => readWorld(path.join(saves, e.name)))
    .filter(Boolean)
    .sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0));
}

/** Dossiers du jeu du launcher officiel : .minecraft et les dossiers propres à chaque profil. */
function officialGameDirs(appData) {
  const root = path.join(appData, '.minecraft');
  const dirs = [root];
  const profiles = readJson(path.join(root, 'launcher_profiles.json'), null)?.profiles ?? {};
  for (const profile of Object.values(profiles)) {
    if (typeof profile?.gameDir !== 'string' || !profile.gameDir.trim()) continue;
    const dir = path.resolve(root, profile.gameDir);
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

/** Nom de dossier libre dans saves (« Survie », « Survie (2) »…), comme le fait le jeu. */
function freeWorldFolder(saves, folder) {
  let name = folder;
  for (let n = 2; fs.existsSync(path.join(saves, name)); n++) name = `${folder} (${n})`;
  return name;
}

/** Copie un monde dans le dossier saves d'une instance. Renvoie le nom du dossier créé. */
async function importWorld({ dir, gameDir, signal, onProgress }) {
  const world = readWorld(dir);
  if (!world) throw new Error("Ce dossier n'est pas un monde Minecraft (level.dat illisible).");
  const saves = path.join(gameDir, 'saves');
  await fsp.mkdir(saves, { recursive: true });
  const folder = freeWorldFolder(saves, world.folder);
  const target = path.join(saves, folder);
  try {
    await copyTree(dir, target, { signal, onProgress, skip: (rel) => rel === 'session.lock' });
  } catch (error) {
    await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { world, folder };
}

module.exports = {
  parseCfg,
  readInstance,
  scanInstances,
  defaultInstancesDir,
  importInstance,
  readWorld,
  scanWorlds,
  officialGameDirs,
  importWorld,
  freeWorldFolder,
  listFiles,
  copyTree,
};
