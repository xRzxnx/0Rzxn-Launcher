'use strict';

// Versions de Minecraft (manifeste officiel Mojang).
const fsp = require('node:fs/promises');
const path = require('node:path');
const { downloadFile, fetchJson } = require('./download');
const { exists, readJson, writeJson } = require('./store');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

const TYPES = { release: 'release', snapshot: 'snapshot', old_beta: 'beta', old_alpha: 'alpha' };

let manifest = null;

/** Manifeste des versions, mis en cache sur le disque pour fonctionner hors connexion. */
async function getManifest(dirs, { refresh = false } = {}) {
  if (manifest && !refresh) return manifest;
  const cacheFile = path.join(dirs.cache, 'version_manifest_v2.json');
  try {
    const data = await fetchJson(MANIFEST_URL);
    writeJson(cacheFile, data);
    manifest = { ...data, offline: false };
  } catch (error) {
    const cached = readJson(cacheFile, null);
    if (!cached) throw new Error(`Impossible de récupérer la liste des versions (${error.message}).`);
    manifest = { ...cached, offline: true };
  }
  return manifest;
}

function versionFiles(dirs, id) {
  return {
    json: path.join(dirs.versions, id, `${id}.json`),
    jar: path.join(dirs.versions, id, `${id}.jar`),
  };
}

function isInstalled(dirs, id) {
  const files = versionFiles(dirs, id);
  return exists(files.json) && exists(files.jar);
}

async function listVersions(dirs) {
  const data = await getManifest(dirs);
  const known = new Set(data.versions.map((v) => v.id));
  const versions = data.versions.map((v) => ({
    id: v.id,
    type: TYPES[v.type] ?? v.type,
    releaseTime: v.releaseTime,
    installed: isInstalled(dirs, v.id),
  }));

  // Versions présentes sur le disque mais absentes du manifeste (plus tard : loaders de mods).
  try {
    for (const id of await fsp.readdir(dirs.versions)) {
      if (known.has(id)) continue;
      const json = readJson(versionFiles(dirs, id).json, null);
      // Les versions de loaders (inheritsFrom) se choisissent dans l'instance, pas dans cette liste.
      if (json && !json.inheritsFrom) versions.push({ id, type: TYPES[json.type] ?? 'custom', releaseTime: json.releaseTime, installed: true });
    }
  } catch {
    // pas encore de dossier versions
  }
  return { latest: data.latest, offline: data.offline, versions };
}

function mergeVersions(parent, child) {
  const merged = { ...parent, ...child };
  // Le jar du jeu est rangé sous le nom de la version enfant (copie du jar vanilla), sauf si elle en désigne un.
  merged.jar = child.jar ?? child.id;
  merged.libraries = [...(child.libraries ?? []), ...(parent.libraries ?? [])];
  if (parent.arguments || child.arguments) {
    merged.arguments = {
      game: [...(parent.arguments?.game ?? []), ...(child.arguments?.game ?? [])],
      jvm: [...(parent.arguments?.jvm ?? []), ...(child.arguments?.jvm ?? [])],
    };
  }
  delete merged.inheritsFrom;
  return merged;
}

/** Fichier de version (vérifié par SHA-1), avec héritage `inheritsFrom` pour les loaders de mods. */
async function getVersionJson(dirs, id) {
  const files = versionFiles(dirs, id);
  let entry = null;
  try {
    entry = (await getManifest(dirs)).versions.find((v) => v.id === id) ?? null;
  } catch {
    // hors connexion sans cache : on tente le fichier local
  }
  if (entry) {
    try {
      await downloadFile({ url: entry.url, path: files.json, sha1: entry.sha1 });
    } catch (error) {
      if (!exists(files.json)) throw new Error(`Impossible de télécharger la version ${id} (${error.message}).`);
    }
  }
  const json = readJson(files.json, null);
  if (!json) throw new Error(`La version ${id} est introuvable.`);
  if (json.inheritsFrom) return mergeVersions(await getVersionJson(dirs, json.inheritsFrom), json);
  return json;
}

async function versionDetails(dirs, id) {
  const json = await getVersionJson(dirs, id);
  return {
    id,
    type: TYPES[json.type] ?? json.type,
    releaseTime: json.releaseTime,
    java: json.javaVersion?.majorVersion ?? 8,
    javaComponent: json.javaVersion?.component ?? 'jre-legacy',
    installed: isInstalled(dirs, id),
  };
}

module.exports = {
  getManifest,
  listVersions,
  getVersionJson,
  versionDetails,
  versionFiles,
  isInstalled,
};
