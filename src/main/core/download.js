// @ts-check
'use strict';

// Téléchargements vérifiés : SHA-1, taille, plusieurs fichiers en parallèle.
// Les requêtes (HTTPS, essais, délais, limites) passent par net.js.
const { t } = require('../i18n');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { fetchBuffer, fetchJson } = require('./net');

/** @typedef {{ url: string, path: string, sha1?: string | null, size?: number | null }} DownloadTask */
/** @typedef {{ done: number, total: number, doneBytes: number, totalBytes: number }} DownloadProgress */

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/**
 * Un fichier déjà présent est gardé si sa taille est bonne (rapide). Avec `verify`,
 * ou si seule l'empreinte est connue, on recalcule le SHA-1.
 */
async function isValid(task, verify) {
  let stat;
  try {
    stat = await fsp.stat(task.path);
  } catch {
    return false;
  }
  if (task.size != null && stat.size !== task.size) return false;
  if (task.sha1 && (verify || task.size == null)) return (await sha1File(task.path)) === task.sha1;
  return stat.size > 0;
}

/**
 * Télécharge `task` ({ url, path, sha1?, size? }) si besoin. Renvoie true si un téléchargement a eu lieu.
 * @param {DownloadTask} task
 * @param {{ signal?: AbortSignal, verify?: boolean, retries?: number }} [options]
 * @returns {Promise<boolean>}
 */
async function downloadFile(task, { signal, verify = false, retries = 2 } = {}) {
  if (await isValid(task, verify)) return false;
  // Les erreurs réseau sont déjà réessayées par net.js : ici, seulement un fichier reçu mais faux (taille, SHA-1).
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const data = await fetchBuffer(task.url, { signal });
    try {
      if (task.size != null && data.length !== task.size) throw new Error(t('download.taille_inattendue_pour', { path: path.basename(task.path) }));
      if (task.sha1 && sha1(data) !== task.sha1) throw new Error(t('download.fichier_corrompu_sha', { path: path.basename(task.path) }));
    } catch (error) {
      lastError = error;
      continue;
    }
    await fsp.mkdir(path.dirname(task.path), { recursive: true });
    const tmp = `${task.path}.${process.pid}.${attempt}.tmp`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, task.path);
    return true;
  }
  throw lastError;
}

/**
 * Télécharge une liste de fichiers (16 à la fois par défaut).
 * onProgress reçoit { done, total, doneBytes, totalBytes }, au plus toutes les 100 ms.
 * @param {DownloadTask[]} tasks
 * @param {{ concurrency?: number, signal?: AbortSignal, verify?: boolean, onProgress?: (progress: DownloadProgress) => void }} [options]
 */
async function downloadAll(tasks, { concurrency = 16, signal, verify = false, onProgress } = {}) {
  const unique = [...new Map(tasks.map((t) => [path.resolve(t.path).toLowerCase(), t])).values()];
  const total = unique.length;
  const totalBytes = unique.reduce((sum, t) => sum + (t.size ?? 0), 0);
  let done = 0;
  let doneBytes = 0;
  let next = 0;
  let lastReport = 0;
  const errors = [];

  const report = (force) => {
    const now = Date.now();
    if (!onProgress || (!force && now - lastReport < 100)) return;
    lastReport = now;
    onProgress({ done, total, doneBytes, totalBytes });
  };

  async function worker() {
    while (next < unique.length) {
      const task = unique[next++];
      try {
        await downloadFile(task, { signal, verify });
      } catch (error) {
        if (signal?.aborted) throw error;
        errors.push({ task, error });
      }
      done += 1;
      doneBytes += task.size ?? 0;
      report(false);
    }
  }

  report(true);
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  report(true);

  if (errors.length) {
    const first = errors[0];
    const error = /** @type {Error & { code?: string }} */ (new Error(
      t('download.failed', { count: errors.length, file: path.basename(first.task.path), error: first.error.message }),
    ));
    error.code = 'DOWNLOAD_FAILED';
    throw error;
  }
}

module.exports = { fetchJson, fetchBuffer, downloadFile, downloadAll, sha1 };
