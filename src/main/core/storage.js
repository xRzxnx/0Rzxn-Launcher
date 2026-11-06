'use strict';

// Espace disque du launcher et nettoyage de ce qui se retélécharge : Java, versions, bibliothèques,
// assets et fichiers du cache que plus aucune instance n'utilise. Uniquement sous la racine du launcher
// (.0rzxn) : les dossiers des instances (mondes, mods, captures) et les sauvegardes ne sont jamais touchés.
const { t } = require('../i18n');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { readJson } = require('./store');
const { versionFiles } = require('./versions');
const { resolveLibraries } = require('./install');
const { listRuntimes } = require('./java');

const PARTS = [
  { id: 'instances', get label() { return t('storage.instances'); } },
  { id: 'assets', get label() { return t('storage.assets'); } },
  { id: 'libraries', get label() { return t('storage.bibliotheques'); } },
  { id: 'backups', get label() { return t('storage.sauvegardes'); } },
  { id: 'runtime', label: 'Java' },
  { id: 'versions', get label() { return t('storage.versions'); } },
  { id: 'cache', get label() { return t('storage.cache'); } },
];
// Les processeurs de Forge et NeoForge écrivent ici des jars qu'aucun fichier de version ne cite :
// on n'y touche pas tant qu'une instance Forge ou NeoForge existe.
const LOADER_OUTPUTS = ['net/minecraftforge', 'net/neoforged', 'net/minecraft'].map((p) => p.split('/').join(path.sep));
// Fichiers du cache inutiles une fois l'installation finie (installateurs Forge, modpacks téléchargés).
const CACHE_DIRS = ['installers', 'modpacks'];

/** Fichiers d'un dossier (récursif, sans suivre les liens) : [{ file, size }]. */
async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) {
      try {
        out.push({ file: full, size: (await fsp.lstat(full)).size });
      } catch {
        // fichier disparu entre-temps
      }
    }
  }
  return out;
}

const sum = (files) => files.reduce((total, f) => total + f.size, 0);
const dirSize = async (dir) => sum(await walk(dir));
const key = (file) => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));

/** Répartition de l'espace utilisé sous la racine du launcher. */
async function usage(dirs) {
  const parts = await Promise.all(PARTS.map(async (p) => ({ ...p, size: await dirSize(dirs[p.id]) })));
  const known = new Set(PARTS.map((p) => key(dirs[p.id])));
  let other = 0;
  for (const entry of await fsp.readdir(dirs.root, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dirs.root, entry.name);
    if (known.has(key(full))) continue;
    other += entry.isDirectory() ? await dirSize(full) : (await fsp.lstat(full).catch(() => ({ size: 0 }))).size;
  }
  if (other) parts.push({ id: 'other', label: t('storage.autres'), size: other });
  return { total: parts.reduce((t, p) => t + p.size, 0), parts };
}

/** Fichier de version fusionné avec ses parents (inheritsFrom), lu sur le disque uniquement. */
function localChain(dirs, id) {
  const chain = [];
  const seen = new Set();
  let current = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const json = readJson(versionFiles(dirs, current).json, null);
    if (!json) break;
    chain.push(json);
    current = json.inheritsFrom;
  }
  return chain;
}

function merged(chain) {
  if (chain.length === 0) return null;
  const libraries = chain.flatMap((json) => json.libraries ?? []);
  return { ...Object.assign({}, ...[...chain].reverse()), libraries, javaVersion: chain.find((j) => j.javaVersion)?.javaVersion };
}

/** Versions, Java, index d'assets et bibliothèques dont les instances ont besoin. */
function inUse(dirs, instances) {
  const versions = new Set();
  const components = new Set();
  const roots = [];
  for (const instance of instances) {
    const top = instance.loader !== 'vanilla' && instance.loaderInstalled?.versionId ? instance.loaderInstalled.versionId : instance.version;
    for (const id of [instance.version, instance.loaderInstalled?.versionId].filter(Boolean)) {
      for (const json of localChain(dirs, id)) versions.add(json.id ?? id);
      versions.add(id);
    }
    const version = merged(localChain(dirs, top));
    if (!version) continue;
    roots.push(version);
    const custom = instance.settings?.java === 'custom' && instance.settings.javaPath;
    if (!custom) components.add(version.javaVersion?.component ?? 'jre-legacy');
  }
  const libraries = new Set();
  const assetIndexes = new Set();
  for (const version of roots) {
    const resolved = resolveLibraries(version, dirs);
    for (const file of [...resolved.classpath, ...resolved.natives.map((n) => n.file), ...resolved.tasks.map((t) => t.path)]) libraries.add(key(file));
    if (version.assetIndex?.id) assetIndexes.add(version.assetIndex.id);
  }
  return { versions, components, libraries, assetIndexes, forgeLike: instances.some((i) => i.loader === 'forge' || i.loader === 'neoforge') };
}

const list = (names) => (names.length <= 3 ? names.join(', ') : t('storage.names_more', { names: names.slice(0, 3).join(', '), count: names.length - 3 }));

/**
 * Ce qui peut partir : [{ id, label, detail, size, count, paths }]. Recalculé avant chaque nettoyage,
 * l'interface ne reçoit jamais de chemins à supprimer.
 */
async function cleanupPlan(dirs, instances) {
  const used = inUse(dirs, instances);
  const items = [];

  const runtimes = listRuntimes(dirs).filter((r) => !used.components.has(r.component));
  const runtimeSizes = await Promise.all(runtimes.map((r) => dirSize(r.dir)));
  items.push({
    id: 'runtimes',
    label: t('storage.java_inutilises'),
    detail: runtimes.length ? t('storage.java_unused', { list: list(runtimes.map((r) => (r.major ? `Java ${r.major}` : r.component))), count: runtimes.length }) : t('storage.chaque_java_sert_au_moins'),
    count: runtimes.length,
    size: runtimeSizes.reduce((a, b) => a + b, 0),
    paths: runtimes.map((r) => r.dir),
  });

  let versionNames = [];
  try {
    versionNames = (await fsp.readdir(dirs.versions, { withFileTypes: true })).filter((d) => d.isDirectory() && !used.versions.has(d.name)).map((d) => d.name);
  } catch {
    // pas encore de versions
  }
  const versionSizes = await Promise.all(versionNames.map((n) => dirSize(path.join(dirs.versions, n))));
  items.push({
    id: 'versions',
    label: t('storage.versions_sans_instance'),
    detail: versionNames.length ? list(versionNames) : t('storage.chaque_version_sert_une_instance'),
    count: versionNames.length,
    size: versionSizes.reduce((a, b) => a + b, 0),
    paths: versionNames.map((n) => path.join(dirs.versions, n)),
  });

  const protectedDirs = used.forgeLike ? LOADER_OUTPUTS.map((p) => key(path.join(dirs.libraries, p)) + path.sep) : [];
  const orphanLibs = (await walk(dirs.libraries)).filter((f) => {
    const k = key(f.file);
    return !used.libraries.has(k) && !protectedDirs.some((p) => k.startsWith(p));
  });
  items.push({
    id: 'libraries',
    label: t('storage.bibliotheques_orphelines'),
    detail: orphanLibs.length ? t('storage.fichiers_que_plus_aucune_version', { count: orphanLibs.length }) : t('storage.toutes_servent_encore'),
    count: orphanLibs.length,
    size: sum(orphanLibs),
    paths: orphanLibs.map((f) => f.file),
  });

  const objects = new Set();
  let indexesReadable = true;
  for (const id of used.assetIndexes) {
    const index = readJson(path.join(dirs.assets, 'indexes', `${id}.json`), null);
    if (!index?.objects) indexesReadable = false;
    else for (const { hash } of Object.values(index.objects)) objects.add(hash);
  }
  // Un index manquant : on ne sait pas quels fichiers il demande, on ne propose rien.
  const orphanAssets = indexesReadable
    ? [
        ...(await walk(path.join(dirs.assets, 'objects'))).filter((f) => !objects.has(path.basename(f.file))),
        ...(await walk(path.join(dirs.assets, 'indexes'))).filter((f) => !used.assetIndexes.has(path.basename(f.file, '.json'))),
      ]
    : [];
  items.push({
    id: 'assets',
    label: t('storage.assets_inutilises'),
    detail: orphanAssets.length ? t('storage.sons_textures_et_langues_de') : t('storage.tous_servent_encore'),
    count: orphanAssets.length,
    size: sum(orphanAssets),
    paths: orphanAssets.map((f) => f.file),
  });

  const cacheFiles = (await Promise.all(CACHE_DIRS.map((d) => walk(path.join(dirs.cache, d))))).flat();
  items.push({
    id: 'cache',
    label: t('storage.cache_de_telechargement'),
    detail: cacheFiles.length ? t('storage.installateurs_forge_et_modpacks_deja') : t('storage.rien_vider'),
    count: cacheFiles.length,
    size: sum(cacheFiles),
    paths: cacheFiles.map((f) => f.file),
  });
  return items;
}

/** Supprime les catégories choisies (définitivement : tout se retélécharge). Renvoie les octets libérés. */
async function clean(dirs, instances, ids) {
  const wanted = new Set(ids);
  const plan = (await cleanupPlan(dirs, instances)).filter((item) => wanted.has(item.id));
  const root = key(dirs.root) + path.sep;
  let freed = 0;
  const failed = [];
  for (const item of plan) {
    for (const target of item.paths) {
      if (!key(target).startsWith(root)) continue; // garde-fou : jamais hors de .0rzxn
      try {
        await fsp.rm(target, { recursive: true, force: true });
      } catch {
        failed.push(target);
      }
    }
    if (item.id === 'libraries' || item.id === 'assets') await pruneEmptyDirs(item.id === 'libraries' ? dirs.libraries : path.join(dirs.assets, 'objects'));
    freed += item.size;
  }
  return { freed, failed: failed.length, done: plan.map((p) => p.id) };
}

/** Dossiers vides laissés par le nettoyage (le dossier de départ reste). */
async function pruneEmptyDirs(dir, isRoot = true) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) if (entry.isDirectory()) await pruneEmptyDirs(path.join(dir, entry.name), false);
  if (!isRoot && (await fsp.readdir(dir).catch(() => ['x'])).length === 0) await fsp.rmdir(dir).catch(() => {});
}

/** Java du launcher avec leur taille et les instances qui s'en servent. */
async function runtimesWithUsage(dirs, instances) {
  const users = new Map();
  for (const instance of instances) {
    const custom = instance.settings?.java === 'custom' && instance.settings.javaPath;
    const top = instance.loader !== 'vanilla' && instance.loaderInstalled?.versionId ? instance.loaderInstalled.versionId : instance.version;
    const version = merged(localChain(dirs, top));
    if (custom || !version) continue;
    const component = version.javaVersion?.component ?? 'jre-legacy';
    if (!users.has(component)) users.set(component, []);
    users.get(component).push(instance.name);
  }
  return Promise.all(listRuntimes(dirs).map(async (r) => ({ ...r, size: await dirSize(r.dir), usedBy: users.get(r.component) ?? [] })));
}

module.exports = { usage, cleanupPlan, clean, runtimesWithUsage, dirSize };
