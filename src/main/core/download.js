// @ts-check
'use strict';

// Téléchargements vérifiés : écrits au fil de l'eau dans un « .part », SHA-1 / SHA-512 et taille contrôlés au passage,
// reprise des gros fichiers coupés, plusieurs fichiers en parallèle.
// Les requêtes (HTTPS, essais, délais, limites) passent par net.js.
const { t } = require('../i18n');
const crypto = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { fetchBuffer, fetchJson, request, sleep, withRetries } = require('./net');

/** Taille à partir de laquelle un fichier coupé reprend où il s'était arrêté (en dessous, il recommence). */
const RESUME_MIN_BYTES = 4 * 1024 * 1024;

/** @typedef {{ url: string, path: string, sha1?: string | null, sha512?: string | null, size?: number | null }} DownloadTask */
/** @typedef {{ done: number, total: number, doneBytes: number, totalBytes: number, speed: number | null, eta: number | null }} DownloadProgress */

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

/** Empreinte d'un fichier, lu par morceaux. @param {string} file @param {'sha1' | 'sha512'} [algorithm] @returns {Promise<string>} */
function hashFile(file, algorithm = 'sha1') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/**
 * Un fichier déjà présent est gardé si sa taille est bonne (rapide). Avec `verify`,
 * ou si seule l'empreinte est connue, on recalcule l'empreinte (SHA-512 si connu, sinon SHA-1).
 * @param {DownloadTask} task @param {boolean} verify
 */
async function isValid(task, verify) {
  let stat;
  try {
    stat = await fsp.stat(task.path);
  } catch {
    return false;
  }
  if (task.size != null && stat.size !== task.size) return false;
  if (verify || task.size == null) {
    if (task.sha512) return (await hashFile(task.path, 'sha512')) === task.sha512;
    if (task.sha1) return (await hashFile(task.path, 'sha1')) === task.sha1;
  }
  return stat.size > 0;
}

/** Fichier reçu mais faux (taille ou empreinte) : le « .part » est jeté et le fichier recommence une fois de zéro. */
const badFile = (message) => Object.assign(new Error(message), { code: 'DOWNLOAD_BAD' });

/** Renommage final ; sous Windows, un antivirus peut tenir le fichier un instant. @param {string} from @param {string} to */
async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await sleep(100 * attempt);
    }
  }
}

/**
 * Un essai : reprend `part` là où il s'est arrêté (gros fichier dont la taille et l'empreinte sont connues), sinon recommence.
 * Le corps est écrit au fil de l'eau, empreintes et taille calculées au passage. Lève `DOWNLOAD_BAD` si le fichier reçu est faux.
 * @param {DownloadTask} task @param {string} part
 * @param {{ signal?: AbortSignal, onBytes?: (received: number) => void, resume: boolean }} options
 */
async function fetchToPart(task, part, { signal, onBytes, resume }) {
  const canResume = resume && task.size != null && task.size >= RESUME_MIN_BYTES && Boolean(task.sha1 || task.sha512);
  let offset = 0;
  if (canResume) {
    try {
      offset = (await fsp.stat(part)).size;
    } catch {
      offset = 0;
    }
    if (task.size != null && offset >= task.size) offset = 0; // « .part » complet mais jamais renommé : on recommence
  }

  // Un seul essai ici : withRetries (dans download) refait tout l'échange, corps compris.
  let handle = await request(task.url, { signal, attempts: 1, headers: offset > 0 ? { Range: `bytes=${offset}-` } : {} });
  if (offset > 0) {
    const range = /^bytes (\d+)-/.exec(handle.response.headers.get('content-range') ?? '');
    if (handle.status !== 206 || Number(range?.[1]) !== offset) {
      // Le serveur renvoie le fichier entier (ou un autre morceau) : on repart de zéro.
      handle.close();
      offset = 0;
      handle = await request(task.url, { signal, attempts: 1 });
    }
  }

  /** @type {Array<{ algorithm: 'sha1' | 'sha512', expected: string, hash: crypto.Hash }>} */
  const hashes = [];
  if (task.sha1) hashes.push({ algorithm: 'sha1', expected: task.sha1, hash: crypto.createHash('sha1') });
  if (task.sha512) hashes.push({ algorithm: 'sha512', expected: task.sha512, hash: crypto.createHash('sha512') });
  if (offset > 0) {
    for await (const chunk of fs.createReadStream(part, { end: offset - 1 })) for (const h of hashes) h.hash.update(chunk);
  }

  let received = offset;
  onBytes?.(received);
  const out = fs.createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' });
  try {
    for await (const chunk of handle.chunks()) {
      for (const h of hashes) h.hash.update(chunk);
      received += chunk.length;
      if (task.size != null && received > task.size) throw badFile(t('download.taille_inattendue_pour', { path: path.basename(task.path) }));
      if (!out.write(chunk)) await once(out, 'drain');
      onBytes?.(received);
    }
    out.end();
    await once(out, 'finish');
  } finally {
    handle.close();
    if (!out.closed) {
      out.destroy();
      await once(out, 'close').catch(() => {});
    }
  }
  if (task.size != null && received !== task.size) throw badFile(t('download.taille_inattendue_pour', { path: path.basename(task.path) }));
  for (const h of hashes) {
    if (h.hash.digest('hex') !== h.expected) throw badFile(t(h.algorithm === 'sha512' ? 'download.fichier_corrompu_sha512' : 'download.fichier_corrompu_sha', { path: path.basename(task.path) }));
  }
}

/** Téléchargements en cours, par fichier : deux demandes du même fichier attendent le même téléchargement. @type {Map<string, Promise<boolean>>} */
const inflight = new Map();

/**
 * Télécharge `task` ({ url, path, sha1?, sha512?, size? }) si besoin. Renvoie true si un téléchargement a eu lieu.
 * `onBytes(reçus)` : octets du fichier déjà reçus (reprise comprise), à chaque morceau.
 * @param {DownloadTask} task
 * @param {{ signal?: AbortSignal, verify?: boolean, onBytes?: (received: number) => void }} [options]
 * @returns {Promise<boolean>}
 */
function downloadFile(task, options = {}) {
  const key = path.resolve(task.path).toLowerCase();
  const running = inflight.get(key);
  if (running) return running;
  const promise = download(task, options).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** @param {DownloadTask} task @param {{ signal?: AbortSignal, verify?: boolean, onBytes?: (received: number) => void }} options */
async function download(task, { signal, verify = false, onBytes } = {}) {
  if (await isValid(task, verify)) return false;
  await fsp.mkdir(path.dirname(task.path), { recursive: true });
  const part = `${task.path}.part`;
  // Une coupure en cours de route est réessayée (en reprenant si possible) ; un fichier faux recommence une fois de zéro.
  for (let fresh = 0; ; fresh++) {
    try {
      await withRetries(() => fetchToPart(task, part, { signal, onBytes, resume: fresh === 0 }), { signal, host: new URL(task.url).host, retryIf: (error) => error.code !== 'DOWNLOAD_BAD' && !error.syscall });
      await renameWithRetry(part, task.path);
      return true;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error.code !== 'DOWNLOAD_BAD' || fresh >= 1) {
        if (error.code === 'DOWNLOAD_BAD') await fsp.rm(part, { force: true });
        throw error;
      }
      await fsp.rm(part, { force: true });
    }
  }
}

/**
 * Vitesse de téléchargement : moyenne glissante sur les 3 dernières secondes (null tant qu'il n'y a pas
 * au moins une demi-seconde de mesures).
 * @param {{ now?: () => number, window?: number }} [options]
 */
function speedMeter({ now = Date.now, window = 3000 } = {}) {
  /** @type {Array<{ at: number, bytes: number }>} */
  const samples = [];
  return {
    /** @param {number} transferred octets reçus depuis le début @returns {number | null} octets par seconde */
    sample(transferred) {
      const at = now();
      samples.push({ at, bytes: transferred });
      while (samples.length > 2 && at - samples[1].at >= window) samples.shift();
      const first = samples[0];
      const elapsed = at - first.at;
      return elapsed >= 500 ? ((transferred - first.bytes) * 1000) / elapsed : null;
    },
  };
}

/**
 * Télécharge une liste de fichiers (16 à la fois par défaut ; net.js applique aussi ses limites globale et par serveur).
 * onProgress reçoit { done, total, doneBytes, totalBytes, speed, eta }, au plus toutes les 100 ms :
 * octets comptés à leur arrivée, vitesse en octets par seconde, temps restant en secondes (null si une taille manque).
 * @param {DownloadTask[]} tasks
 * @param {{ concurrency?: number, signal?: AbortSignal, verify?: boolean, onProgress?: (progress: DownloadProgress) => void, now?: () => number }} [options]
 */
async function downloadAll(tasks, { concurrency = 16, signal, verify = false, onProgress, now = Date.now } = {}) {
  const unique = [...new Map(tasks.map((t) => [path.resolve(t.path).toLowerCase(), t])).values()];
  const total = unique.length;
  const totalBytes = unique.reduce((sum, t) => sum + (t.size ?? 0), 0);
  const sizesKnown = unique.every((t) => t.size != null);
  const meter = speedMeter({ now });
  /** Octets reçus de chaque fichier en cours. @type {Map<DownloadTask, number>} */
  const current = new Map();
  let done = 0;
  let finishedBytes = 0; // fichiers terminés (ou déjà présents)
  let transferred = 0; // octets vraiment reçus, pour la vitesse
  let next = 0;
  let lastReport = 0;
  /** @type {number | null} */
  let speed = null;
  const errors = [];

  const report = (force) => {
    if (!onProgress) return;
    const at = now();
    if (!force && at - lastReport < 100) return;
    lastReport = at;
    speed = meter.sample(transferred) ?? speed;
    let doneBytes = finishedBytes;
    for (const bytes of current.values()) doneBytes += bytes;
    const eta = sizesKnown && speed ? Math.max(0, Math.round((totalBytes - doneBytes) / speed)) : null;
    onProgress({ done, total, doneBytes, totalBytes, speed, eta });
  };

  async function worker() {
    while (next < unique.length) {
      const task = unique[next++];
      /** @type {number | null} */
      let seen = null;
      current.set(task, 0);
      try {
        await downloadFile(task, {
          signal,
          verify,
          onBytes: (received) => {
            // Une reprise compte comme déjà reçu ; seuls les nouveaux octets font la vitesse.
            if (seen != null && received > seen) transferred += received - seen;
            seen = received;
            current.set(task, received);
            report(false);
          },
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        errors.push({ task, error });
      }
      current.delete(task);
      done += 1;
      finishedBytes += task.size ?? seen ?? 0;
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

module.exports = { fetchJson, fetchBuffer, downloadFile, downloadAll, sha1, hashFile, speedMeter };
