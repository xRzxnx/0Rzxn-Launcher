// @ts-check
'use strict';

// Requêtes HTTP communes du launcher : HTTPS obligatoire, redirections contrôlées, délai d'inactivité,
// nouveaux essais avec attente croissante, Retry-After, limites globale et par serveur.
const { t } = require('../i18n');

const MAX_REDIRECTS = 5;
const ATTEMPTS = 4;
const IDLE_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_MS = 60_000;
const BACKOFF_CAP_MS = 10_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const settings = {
  concurrency: 16,
  perHost: 8,
  userAgent: '0Rzxn_Launcher (+https://github.com/xRzxnx/0Rzxn-Launcher)',
  backoffBase: 500,
  /** Tests seulement : serveurs locaux joignables en clair. @type {Set<string>} */
  insecureHosts: new Set(),
};

/**
 * Réglages : limites (bornées), version du launcher dans le User-Agent.
 * `insecureHosts` et `backoffBase` ne servent qu'aux tests.
 * @param {{ concurrency?: number, perHost?: number, version?: string, insecureHosts?: string[], backoffBase?: number }} options
 */
function configure({ concurrency, perHost, version, insecureHosts, backoffBase } = {}) {
  const bounded = (value, min, max, fallback) => (Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback);
  settings.concurrency = bounded(concurrency, 1, 64, settings.concurrency);
  settings.perHost = bounded(perHost, 1, 32, settings.perHost);
  if (version) settings.userAgent = `0Rzxn_Launcher/${version} (+https://github.com/xRzxnx/0Rzxn-Launcher)`;
  if (insecureHosts) settings.insecureHosts = new Set(insecureHosts);
  if (Number.isFinite(backoffBase)) settings.backoffBase = /** @type {number} */ (backoffBase);
}

// ---------- Limites ----------

/** Compteur de places : la limite est relue à chaque fois (réglage changé à chaud). */
class Slots {
  /** @param {() => number} limit */
  constructor(limit) {
    this.limit = limit;
    this.used = 0;
    /** @type {Array<() => void>} */
    this.waiting = [];
  }

  /** @param {AbortSignal} [signal] */
  async acquire(signal) {
    while (this.used >= this.limit()) {
      signal?.throwIfAborted();
      await new Promise((resolve) => {
        const wake = () => {
          signal?.removeEventListener('abort', wake);
          resolve(undefined);
        };
        this.waiting.push(wake);
        signal?.addEventListener('abort', wake, { once: true });
      });
    }
    signal?.throwIfAborted();
    this.used += 1;
  }

  release() {
    this.used = Math.max(0, this.used - 1);
    this.waiting.shift()?.();
  }
}

const allSlots = new Slots(() => settings.concurrency);
/** @type {Map<string, Slots>} */
const hostSlots = new Map();
/** Serveur qui a annoncé sa limite atteinte (X-Ratelimit-Remaining: 0) : pas de requête avant cette date. @type {Map<string, number>} */
const pausedUntil = new Map();

/** @param {string} host */
function slotsFor(host) {
  let slots = hostSlots.get(host);
  if (!slots) hostSlots.set(host, (slots = new Slots(() => settings.perHost)));
  return slots;
}

/** @param {number} ms @param {AbortSignal} [signal] */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', stop);
      resolve(undefined);
    }
    function stop() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener('abort', stop, { once: true });
  });
}

// ---------- Adresses ----------

/** HTTPS obligatoire : http:// est réécrit en https:// (jamais de repli en clair). @param {string | URL} raw */
function secureUrl(raw) {
  const url = new URL(String(raw));
  if (url.protocol === 'http:' && !settings.insecureHosts.has(url.hostname)) url.protocol = 'https:';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && settings.insecureHosts.has(url.hostname))) {
    throw Object.assign(new Error(t('net.adresse_refusee', { url: url.href })), { code: 'NET_INSECURE' });
  }
  return url;
}

/** Retry-After : secondes ou date HTTP, en millisecondes (null si absent ou illisible). @param {string | null} value @param {number} now */
function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** Attente avant l'essai `attempt` (1, 2, 3…) : au hasard entre 0 et min(10 s, base × 2^(essai-1)). @param {number} attempt */
function backoffMs(attempt) {
  return Math.random() * Math.min(BACKOFF_CAP_MS, settings.backoffBase * 2 ** (attempt - 1));
}

// ---------- Une requête ----------

/**
 * Réponse ouverte : les places (globale et serveur) restent prises jusqu'à close().
 * @typedef {object} Handle
 * @property {Response} response
 * @property {number} status
 * @property {URL} url adresse finale, après redirections
 * @property {() => AsyncGenerator<Uint8Array>} chunks corps reçu morceau par morceau (le délai d'inactivité repart à chaque morceau)
 * @property {() => Promise<Buffer>} buffer
 * @property {() => void} close
 */

/**
 * Envoie une requête (redirections suivies à la main) et prend ses places. Pas de nouvel essai ici.
 * @param {string | URL} raw
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal, idleTimeout?: number }} [options]
 * @returns {Promise<Handle>}
 */
async function send(raw, { method = 'GET', headers = {}, body, signal, idleTimeout = IDLE_TIMEOUT_MS } = {}) {
  let url = secureUrl(raw);
  const firstHost = url.host;
  const paused = pausedUntil.get(firstHost);
  if (paused && paused > Date.now()) await sleep(paused - Date.now(), signal);

  const host = slotsFor(firstHost);
  await allSlots.acquire(signal);
  try {
    await host.acquire(signal);
  } catch (error) {
    allSlots.release();
    throw error;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    host.release();
    allSlots.release();
  };

  // Délai d'inactivité : relancé à chaque morceau reçu, pas un délai total.
  const idle = new AbortController();
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(Object.assign(new Error(t('net.ne_repond_plus', { host: url.host, seconds: Math.round(idleTimeout / 1000) })), { code: 'NET_IDLE' })), idleTimeout);
  };
  const combined = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;

  try {
    let response;
    for (let hop = 0; ; hop++) {
      touch();
      try {
        response = await fetch(url, { method, body, redirect: 'manual', signal: combined, headers: { 'User-Agent': settings.userAgent, ...headers } });
      } catch (error) {
        throw idle.signal.aborted ? idle.signal.reason : error;
      }
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (!location) break;
      await response.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw Object.assign(new Error(t('net.trop_de_redirections', { host: url.host })), { code: 'NET_REDIRECTS' });
      const next = new URL(location, url);
      if (next.protocol !== 'https:' && !(next.protocol === 'http:' && settings.insecureHosts.has(next.hostname))) {
        throw Object.assign(new Error(t('net.redirection_refusee', { host: next.host || next.protocol })), { code: 'NET_INSECURE' });
      }
      url = next;
    }
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    if (remaining === '0' && Number.isFinite(reset)) pausedUntil.set(firstHost, Date.now() + reset * 1000);

    const finalUrl = url;
    const res = response;
    async function* chunks() {
      if (!res.body) return;
      try {
        for await (const chunk of res.body) {
          touch();
          yield chunk;
        }
      } catch (error) {
        throw idle.signal.aborted ? idle.signal.reason : error;
      }
    }
    return {
      response: res,
      status: res.status,
      url: finalUrl,
      chunks,
      async buffer() {
        const parts = [];
        for await (const chunk of chunks()) parts.push(chunk);
        return Buffer.concat(parts);
      },
      close() {
        if (!res.bodyUsed) res.body?.cancel().catch(() => {});
        release();
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** Erreur HTTP (statut non 2xx) avec son statut et l'attente demandée par le serveur. @param {Handle} handle */
function httpError(handle) {
  const error = /** @type {Error & { status?: number, retryAfter?: number | null }} */ (
    new Error(t('download.reponse_de', { status: handle.status, host: handle.url.host }))
  );
  error.status = handle.status;
  error.retryAfter = retryAfterMs(handle.response.headers.get('retry-after'));
  return error;
}

/** Erreur à réessayer : réseau, délai d'inactivité, ou statut 408, 425, 429, 5xx. @param {any} error */
function retryable(error) {
  if (error?.code === 'NET_INSECURE' || error?.code === 'NET_REDIRECTS') return false;
  if (error?.status != null) return RETRYABLE_STATUS.has(error.status);
  return true;
}

/**
 * Exécute `work` (une requête et sa lecture) avec jusqu'à 4 essais.
 * @template T
 * @param {(attempt: number) => Promise<T>} work
 * @param {{ signal?: AbortSignal, attempts?: number, host?: string, retryIf?: (error: any) => boolean }} [options]
 * @returns {Promise<T>}
 */
async function withRetries(work, { signal, attempts = ATTEMPTS, host = '', retryIf = () => true } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work(attempt);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (attempt >= attempts || !retryable(error) || !retryIf(error)) throw error;
      const wait = error?.retryAfter ?? backoffMs(attempt);
      if (wait > MAX_RETRY_AFTER_MS) {
        throw Object.assign(new Error(t('net.attendre_avant_de_reessayer', { host, seconds: Math.ceil(wait / 1000) })), { status: error.status });
      }
      await sleep(wait, signal);
    }
  }
}

/**
 * Requête avec nouveaux essais, réponse 2xx ouverte : l'appelant lit le corps puis appelle close().
 * @param {string | URL} url
 * @param {Parameters<typeof send>[1] & { attempts?: number }} [options]
 * @returns {Promise<Handle>}
 */
function request(url, options = {}) {
  const host = secureUrl(url).host;
  return withRetries(async () => {
    const handle = await send(url, options);
    if (handle.status >= 200 && handle.status < 300) return handle;
    handle.close();
    throw httpError(handle);
  }, { signal: options.signal, attempts: options.attempts, host });
}

/** Corps entier en mémoire (petites réponses : manifestes, API). @param {string | URL} url @param {Parameters<typeof send>[1]} [options] */
function fetchBuffer(url, options = {}) {
  const host = secureUrl(url).host;
  return withRetries(async () => {
    const handle = await send(url, options);
    try {
      if (handle.status < 200 || handle.status >= 300) throw httpError(handle);
      return await handle.buffer();
    } finally {
      handle.close();
    }
  }, { signal: options.signal, host });
}

/** @param {string | URL} url @param {Parameters<typeof send>[1]} [options] */
async function fetchJson(url, options = {}) {
  return JSON.parse((await fetchBuffer(url, options)).toString('utf8'));
}

/** Limites en vigueur (tests, diagnostic). */
const limits = () => ({ concurrency: settings.concurrency, perHost: settings.perHost });

module.exports = { configure, limits, secureUrl, retryAfterMs, backoffMs, send, request, withRetries, fetchBuffer, fetchJson, sleep };
