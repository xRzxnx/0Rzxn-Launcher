'use strict';

// Fichiers du jeu : jar client, bibliothèques, natives, assets et configuration des logs.
const { t } = require('../i18n');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { downloadFile } = require('./download');
const { exists, readJson } = require('./store');
const { mavenPath, nativeArchMatches, osName, parseMaven, ruleAllows } = require('./rules');
const { versionFiles } = require('./versions');
const zip = require('./zip');

const LIBRARIES_URL = 'https://libraries.minecraft.net/';
const RESOURCES_URL = 'https://resources.download.minecraft.net/';
const NATIVE_FILE = /\.(dll|so|dylib|jnilib)$/i;

/** Bibliothèques autorisées sur ce système : classpath, jars de natives et fichiers à télécharger. */
function resolveLibraries(version, dirs) {
  const os = osName();
  const bits = process.arch === 'ia32' ? '32' : '64';
  const classpath = new Map();
  const natives = [];
  const tasks = [];

  for (const lib of version.libraries ?? []) {
    if (!ruleAllows(lib.rules)) continue;
    const parts = parseMaven(lib.name);
    if (!nativeArchMatches(parts.classifier)) continue;

    const artifact = lib.downloads?.artifact;
    if (artifact || !lib.natives) {
      const file = path.join(dirs.libraries, artifact?.path ?? mavenPath(lib.name));
      const url = artifact ? artifact.url : `${(lib.url ?? LIBRARIES_URL).replace(/\/?$/, '/')}${mavenPath(lib.name)}`;
      if (url) tasks.push({ url, path: file, sha1: artifact?.sha1, size: artifact?.size });
      // Les bibliothèques du loader (listées en premier) l'emportent sur celles de la version vanilla.
      const key = `${parts.group}:${parts.artifact}:${parts.classifier ?? ''}`;
      if (!classpath.has(key)) classpath.set(key, file);
      if (parts.classifier?.startsWith('natives-')) natives.push({ file, exclude: lib.extract?.exclude ?? [] });
    }

    // Ancien format (avant 1.19) : natives dans un « classifieur » séparé.
    const nativeKey = lib.natives?.[os]?.replace('${arch}', bits);
    if (nativeKey) {
      const download = lib.downloads?.classifiers?.[nativeKey];
      const rel = download?.path ?? mavenPath(`${lib.name}:${nativeKey}`);
      const file = path.join(dirs.libraries, rel);
      tasks.push({
        url: download?.url ?? `${(lib.url ?? LIBRARIES_URL).replace(/\/?$/, '/')}${rel}`,
        path: file,
        sha1: download?.sha1,
        size: download?.size,
      });
      natives.push({ file, exclude: lib.extract?.exclude ?? [] });
    }
  }
  return { classpath: [...classpath.values()], natives, tasks };
}

function clientJar(version, dirs) {
  return versionFiles(dirs, version.jar ?? version.id).jar;
}

function clientTask(version, dirs) {
  const client = version.downloads?.client;
  if (!client) return null;
  return { url: client.url, path: clientJar(version, dirs), sha1: client.sha1, size: client.size };
}

/** Télécharge l'index des assets puis renvoie la liste des objets (sons, textures, langues…). */
async function prepareAssets(version, dirs, { signal, verify } = {}) {
  const info = version.assetIndex;
  const indexFile = path.join(dirs.assets, 'indexes', `${info.id}.json`);
  try {
    await downloadFile({ url: info.url, path: indexFile, sha1: info.sha1, size: info.size }, { signal, verify });
  } catch (error) {
    if (!exists(indexFile)) throw error;
  }
  const index = readJson(indexFile, null);
  if (!index?.objects) throw new Error(t('install.index_des_assets_illisible', { id: info.id }));
  const tasks = Object.values(index.objects).map(({ hash, size }) => ({
    url: `${RESOURCES_URL}${hash.slice(0, 2)}/${hash}`,
    path: path.join(dirs.assets, 'objects', hash.slice(0, 2), hash),
    sha1: hash,
    size,
  }));
  return { index, tasks };
}

/** Versions d'avant 1.7 : les assets doivent être recopiés sous leur vrai nom. Renvoie le dossier à utiliser. */
async function reconstructAssets(index, assetsId, dirs, gameDir) {
  if (!index.virtual && !index.map_to_resources) return null;
  const target = index.map_to_resources ? path.join(gameDir, 'resources') : path.join(dirs.assets, 'virtual', assetsId);
  for (const [name, { hash, size }] of Object.entries(index.objects)) {
    const dest = path.join(target, name);
    try {
      if ((await fsp.stat(dest)).size === size) continue;
    } catch {
      // absent : on le copie
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(path.join(dirs.assets, 'objects', hash.slice(0, 2), hash), dest);
  }
  return target;
}

function loggingTask(version, dirs) {
  const file = version.logging?.client?.file;
  if (!file) return null;
  return { url: file.url, path: path.join(dirs.assets, 'log_configs', file.id), sha1: file.sha1, size: file.size };
}

/** Extrait les DLL des natives à plat dans `target` (vidé avant). */
async function extractNatives(natives, target) {
  await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(target, { recursive: true });
  let count = 0;
  for (const { file, exclude } of natives) {
    const buffer = await fsp.readFile(file);
    for (const entry of zip.listEntries(buffer)) {
      if (entry.name.endsWith('/') || entry.name.startsWith('META-INF/')) continue;
      if (exclude.some((prefix) => entry.name.startsWith(prefix))) continue;
      if (!NATIVE_FILE.test(entry.name)) continue;
      try {
        await fsp.writeFile(path.join(target, path.basename(entry.name)), zip.readEntry(buffer, entry));
        count += 1;
      } catch (error) {
        // DLL encore utilisée par une partie en cours : la copie existante convient.
        if (error.code !== 'EBUSY' && error.code !== 'EPERM') throw error;
      }
    }
  }
  return count;
}

module.exports = {
  resolveLibraries,
  clientJar,
  clientTask,
  prepareAssets,
  reconstructAssets,
  loggingTask,
  extractNatives,
};
