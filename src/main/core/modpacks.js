'use strict';

// Modpacks au format Modrinth (.mrpack) : installation, mise à jour et export.
// Format : https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack
const { t } = require('../i18n');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const content = require('./content');
const { downloadAll, downloadFile } = require('./download');
const { packLoaderVersion, resolveLoaderVersion } = require('./loaders');
const modrinth = require('./modrinth');
const zip = require('./zip');

// Seules sources autorisées par le format .mrpack
const ALLOWED_HOSTS = new Set(['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']);
const LOADER_KEYS = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge', neoforge: 'neoforge' };
const PACK_KEYS = Object.fromEntries(Object.entries(LOADER_KEYS).map(([key, loader]) => [loader, key]));
// À la mise à jour, on ne remplace jamais les réglages ni les mondes du joueur.
const keepOnUpdate = (rel) => rel === 'options.txt' || rel.startsWith('saves/');

/** Chemin dans le dossier du jeu, en refusant toute sortie du dossier (« ../ », chemin absolu). */
function safeTarget(gameDir, rel) {
  const clean = String(rel ?? '').replace(/\\/g, '/');
  const root = path.resolve(gameDir);
  const target = path.resolve(root, clean);
  if (!clean || path.isAbsolute(clean) || !target.startsWith(root + path.sep)) throw new Error(t('modpacks.chemin_refuse_dans_le_modpack', { rel }));
  return target;
}

function readPack(buffer) {
  let entries;
  try {
    entries = zip.listEntries(buffer);
  } catch {
    throw new Error(t('modpacks.ce_fichier_est_pas_une'));
  }
  const raw = zip.readFile(buffer, 'modrinth.index.json', entries);
  if (!raw) throw new Error(t('modpacks.ce_fichier_est_pas_un'));
  const index = JSON.parse(raw.toString('utf8'));
  if (index.game !== 'minecraft' || !index.dependencies?.minecraft) throw new Error(t('modpacks.modpack_invalide_version_de_minecraft'));
  const keys = Object.keys(index.dependencies).filter((k) => k !== 'minecraft');
  const unknown = keys.filter((k) => !LOADER_KEYS[k]);
  if (unknown.length) throw new Error(t('modpacks.loader_non_pris_en_charge', { unknown: unknown.join(', ') }));
  const loaderKey = keys[0];
  return {
    entries,
    index,
    mc: index.dependencies.minecraft,
    loader: loaderKey ? LOADER_KEYS[loaderKey] : 'vanilla',
    packLoaderVersion: loaderKey ? index.dependencies[loaderKey] : null,
  };
}

function fileTasks(gameDir, index) {
  return index.files
    .filter((f) => f.env?.client !== 'unsupported')
    .map((f) => {
      const url = f.downloads.find((u) => {
        try {
          const parsed = new URL(u);
          return parsed.protocol === 'https:' && ALLOWED_HOSTS.has(parsed.host);
        } catch {
          return false;
        }
      });
      if (!url) throw new Error(t('modpacks.source_de_telechargement_non_autorisee', { path: f.path }));
      return { url, path: safeTarget(gameDir, f.path), sha1: f.hashes?.sha1, size: f.fileSize, rel: f.path.replace(/\\/g, '/') };
    });
}

async function applyOverrides(buffer, entries, gameDir, { update = false } = {}) {
  let count = 0;
  for (const prefix of ['overrides/', 'client-overrides/']) {
    for (const entry of entries) {
      if (!entry.name.startsWith(prefix) || entry.name.endsWith('/')) continue;
      const rel = entry.name.slice(prefix.length);
      const target = safeTarget(gameDir, rel);
      if (update && keepOnUpdate(rel) && fs.existsSync(target)) continue;
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, zip.readEntry(buffer, entry));
      count += 1;
    }
  }
  return count;
}

/** Télécharge le .mrpack d'une version Modrinth (vérifié par SHA-1) et renvoie son contenu. */
async function downloadPack(dirs, versionId, signal) {
  const v = await modrinth.version(versionId);
  const file = v.files.find((f) => f.filename.endsWith('.mrpack')) ?? v.file;
  if (!file?.filename.endsWith('.mrpack')) throw new Error(t('modpacks.cette_version_est_pas_un'));
  const target = path.join(dirs.cache, 'modpacks', path.basename(file.filename));
  await downloadFile({ url: file.url, path: target, sha1: file.sha1, size: file.size }, { signal });
  return { buffer: await fsp.readFile(target), version: v };
}

/** Crée une nouvelle instance à partir d'un .mrpack. `source` : { projectId, versionId, title, icon } si le pack vient de Modrinth. */
async function installPack({ instances, buffer, defaults, source = null, signal, onProgress, log = () => {} }) {
  const pack = readPack(buffer);
  const loaderVersion = pack.loader === 'vanilla' ? null : await resolveLoaderVersion(pack.loader, pack.mc, pack.packLoaderVersion);
  const instance = instances.create({ name: source?.title ?? pack.index.name, icon: 'grass', version: pack.mc, loader: pack.loader, loaderVersion }, defaults);
  const gameDir = instances.gameDir(instance.id);
  let tasks;
  try {
    tasks = fileTasks(gameDir, pack.index);
    log(t('modpacks.summary', { name: pack.index.name, version: pack.index.versionId, files: tasks.length, mc: `${pack.mc}${loaderVersion ? `, ${pack.loader} ${loaderVersion}` : ''}` }));
    await downloadAll(tasks, { signal, onProgress });
    const overrides = await applyOverrides(buffer, pack.entries, gameDir);
    log(t('modpacks.fichiers_de_configuration_copies', { overrides }));
  } catch (error) {
    // Instance incomplète : on la retire (elle vient d'être créée, rien d'autre dedans).
    await fsp.rm(instances.dir(instance.id), { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  instances.setModpack(instance.id, {
    projectId: source?.projectId ?? null,
    versionId: source?.versionId ?? null,
    name: pack.index.name,
    version: pack.index.versionId,
    icon: source?.icon ?? null,
    files: tasks.map((t) => t.rel),
  });
  return instances.get(instance.id);
}

/** Met à jour une instance issue d'un modpack : fichiers retirés du pack → corbeille, nouveaux fichiers téléchargés. */
async function updatePack({ instances, instanceId, buffer, source = null, trash, signal, onProgress }) {
  const instance = instances.get(instanceId);
  const pack = readPack(buffer);
  const loaderVersion = pack.loader === 'vanilla' ? null : await resolveLoaderVersion(pack.loader, pack.mc, pack.packLoaderVersion);
  const gameDir = instances.gameDir(instanceId);
  const tasks = fileTasks(gameDir, pack.index);
  const keep = new Set(tasks.map((t) => t.rel));
  let removed = 0;
  for (const rel of instance.modpack?.files ?? []) {
    if (keep.has(rel)) continue;
    const target = safeTarget(gameDir, rel);
    if (fs.existsSync(target)) {
      await trash(target);
      removed += 1;
    }
  }
  await downloadAll(tasks, { signal, onProgress });
  await applyOverrides(buffer, pack.entries, gameDir, { update: true });
  instances.update(instanceId, { version: pack.mc, loader: pack.loader, loaderVersion });
  instances.setModpack(instanceId, {
    ...instance.modpack,
    projectId: source?.projectId ?? instance.modpack?.projectId ?? null,
    versionId: source?.versionId ?? null,
    name: pack.index.name,
    version: pack.index.versionId,
    files: tasks.map((t) => t.rel),
  });
  return { instance: instances.get(instanceId), removed, files: tasks.length };
}

/** Dernière version Modrinth d'un modpack installé, si elle est différente. */
async function checkUpdate(instance) {
  const pack = instance.modpack;
  if (!pack?.projectId) return null;
  const list = await modrinth.versions(pack.projectId, {}); // les plus récentes d'abord
  const index = list.findIndex((v) => v.id === pack.versionId);
  const newer = index === -1 ? list : list.slice(0, index);
  const installedType = index === -1 ? 'release' : list[index].type;
  // Une bêta n'est proposée qu'à qui a déjà une bêta.
  const next = installedType === 'release' ? newer.find((v) => v.type === 'release') : newer[0];
  if (!next) return null;
  return { versionId: next.id, number: next.number, type: next.type };
}

async function walk(dir, base = dir) {
  let out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(await walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

/**
 * Exporte une instance en .mrpack : les fichiers connus de Modrinth sont référencés (le pack reste
 * léger), les autres (mods locaux, configuration) sont copiés dans « overrides/ ».
 */
async function exportPack({ instance, gameDir, name, version, summary }) {
  const candidates = [];
  for (const kind of ['mods', 'resourcepacks', 'shaders']) {
    const folder = content.KINDS[kind].folder;
    for (const rel of await walk(path.join(gameDir, folder))) {
      if (rel.endsWith('.disabled')) continue; // désactivé : pas dans le pack
      candidates.push({ kind, rel: `${folder}/${rel}`, top: !rel.includes('/') });
    }
  }
  const hashed = await Promise.all(
    candidates.map(async (c) => {
      const data = await fsp.readFile(path.join(gameDir, c.rel));
      return { ...c, data, sha1: crypto.createHash('sha1').update(data).digest('hex'), sha512: crypto.createHash('sha512').update(data).digest('hex') };
    }),
  );

  let known = {};
  try {
    known = await modrinth.versionsByHash(hashed.filter((f) => f.top).map((f) => f.sha1));
  } catch {
    known = {}; // hors connexion : tout part dans overrides/
  }

  const files = [];
  const archive = [];
  for (const f of hashed) {
    const remote = f.top && known[f.sha1]?.files.find((x) => x.sha1 === f.sha1);
    if (remote) {
      files.push({
        path: f.rel,
        hashes: { sha1: f.sha1, sha512: remote.sha512 ?? f.sha512 },
        env: { client: 'required', server: f.kind === 'mods' ? 'required' : 'unsupported' },
        downloads: [remote.url],
        fileSize: f.data.length,
      });
    } else {
      archive.push({ name: `overrides/${f.rel}`, data: f.data });
    }
  }
  for (const rel of await walk(path.join(gameDir, 'config'))) {
    archive.push({ name: `overrides/config/${rel}`, data: await fsp.readFile(path.join(gameDir, 'config', rel)) });
  }

  const dependencies = { minecraft: instance.version };
  if (instance.loader !== 'vanilla') dependencies[PACK_KEYS[instance.loader]] = packLoaderVersion(instance.loader, instance.version, instance.loaderVersion);
  const index = { formatVersion: 1, game: 'minecraft', versionId: version, name, summary: summary || undefined, files, dependencies };
  const buffer = zip.createZip([{ name: 'modrinth.index.json', data: Buffer.from(JSON.stringify(index, null, 2)) }, ...archive]);
  return { buffer, referenced: files.length, embedded: archive.length };
}

module.exports = { readPack, downloadPack, installPack, updatePack, checkUpdate, exportPack };
