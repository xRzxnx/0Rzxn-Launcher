// @ts-check
'use strict';

// Fichiers temporaires abandonnés : téléchargements interrompus (« .part ») et anciens « .tmp » d'avant la phase 4.
// Seuls les dossiers où le launcher télécharge sont parcourus ; jamais les mondes (« saves »).
const fsp = require('node:fs').promises;
const path = require('node:path');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** Téléchargements : « .part » gardés 7 jours (reprise possible), « .tmp » des anciennes versions retirés après 1 heure. */
const DOWNLOAD_RULES = [
  { test: (/** @type {string} */ name) => name.endsWith('.part'), maxAge: 7 * DAY },
  { test: (/** @type {string} */ name) => /\.\d+\.\d+\.tmp$/.test(name), maxAge: HOUR },
];
/** Sauvegardes de mondes : un « .part » de plus d'un jour est une sauvegarde qui ne finira jamais. */
const BACKUP_RULES = [{ test: (/** @type {string} */ name) => name.endsWith('.part'), maxAge: DAY }];
const CONTENT_FOLDERS = ['mods', 'resourcepacks', 'shaderpacks'];

/** @param {string} dir @param {boolean} deep @returns {AsyncGenerator<string>} */
async function* files(dir, deep) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) yield full;
    else if (deep && entry.isDirectory()) yield* files(full, deep); // les liens ne sont pas suivis
  }
}

/**
 * Retire les fichiers temporaires abandonnés. Renvoie leur nombre et leur taille totale.
 * @param {{ dirs: { versions: string, libraries: string, assets: string, runtime: string, cache: string, instances: string, backups: string }, now?: number, signal?: AbortSignal }} options
 */
async function cleanTemporaryFiles({ dirs, now = Date.now(), signal }) {
  const roots = [dirs.versions, dirs.libraries, dirs.assets, dirs.runtime, dirs.cache].map((dir) => ({ dir, deep: true, rules: DOWNLOAD_RULES }));
  let instances = [];
  try {
    instances = await fsp.readdir(dirs.instances, { withFileTypes: true });
  } catch {
    // pas encore d'instance
  }
  for (const entry of instances) {
    if (!entry.isDirectory()) continue;
    for (const folder of CONTENT_FOLDERS) roots.push({ dir: path.join(dirs.instances, entry.name, 'minecraft', folder), deep: false, rules: DOWNLOAD_RULES });
  }
  roots.push({ dir: dirs.backups, deep: true, rules: BACKUP_RULES });

  let count = 0;
  let bytes = 0;
  for (const { dir, deep, rules } of roots) {
    for await (const file of files(dir, deep)) {
      signal?.throwIfAborted();
      const name = path.basename(file);
      const rule = rules.find((r) => r.test(name));
      if (!rule) continue;
      try {
        const stat = await fsp.stat(file);
        if (now - stat.mtimeMs < rule.maxAge) continue;
        await fsp.rm(file, { force: true });
        count += 1;
        bytes += stat.size;
      } catch {
        // fichier disparu ou verrouillé : il sera retiré une autre fois
      }
    }
  }
  return { count, bytes };
}

module.exports = { cleanTemporaryFiles };
