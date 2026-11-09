// @ts-check
'use strict';

// Journal général du launcher (technique, jamais affiché) : un fichier par démarrage dans userData/logs,
// les précédents gardés (launcher.log, launcher-1.log … launcher-4.log) et un nouveau fichier quand
// celui-ci devient trop gros. Les secrets sont masqués avant l'écriture : ceux déclarés avec addSecret
// (via censor de logs.js) et les jetons reconnaissables à leur forme. Écriture synchrone : une erreur
// juste avant un plantage est quand même notée. Le journal ne doit jamais gêner le launcher.
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { censor } = require('./logs');

/** @typedef {'debug' | 'info' | 'warn' | 'error'} Level */
/** @type {Record<Level, number>} */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const KEEP = 5;
const MAX_BYTES = 4 * 1024 * 1024;
const MASK = '••••••••';
/** Jetons repérés à leur forme, même s'ils n'ont pas été déclarés. @type {Array<[RegExp, string]>} */
const PATTERNS = [
  [/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, MASK],
  [/(--accessToken|--xuid|--clientId)(\s+)\S+/g, `$1$2${MASK}`],
  [/("?(?:access_?token|refresh_?token|id_?token)"?\s*[:=]\s*"?)[^"\s,}&]+/gi, `$1${MASK}`],
];

/**
 * @typedef {object} Journal
 * @property {string} file
 * @property {(...args: unknown[]) => void} debug
 * @property {(...args: unknown[]) => void} info
 * @property {(...args: unknown[]) => void} warn
 * @property {(...args: unknown[]) => void} error
 * @property {(secret: string | null | undefined) => void} addSecret
 */

const pad = (/** @type {number} */ n, size = 2) => String(n).padStart(size, '0');

/** « 2026-11-09 14:03:12.345 », heure locale. */
function stamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** @param {unknown} value */
function format(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  return util.inspect(value, { depth: 4, breakLength: Infinity });
}

/**
 * @param {{ dir: string, file?: string, keep?: number, maxBytes?: number, level?: Level, now?: () => Date }} options
 * @returns {Journal}
 */
function createJournal({ dir, file = 'launcher.log', keep = KEEP, maxBytes = MAX_BYTES, level = 'info', now = () => new Date() }) {
  const target = path.join(dir, file);
  const base = file.replace(/\.log$/, '');
  const archived = (/** @type {number} */ n) => path.join(dir, `${base}-${n}.log`);
  /** @type {Set<string>} */
  const secrets = new Set();
  let size = 0;

  function rotate() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (keep <= 1) {
        fs.rmSync(target, { force: true });
      } else {
        fs.rmSync(archived(keep - 1), { force: true });
        for (let n = keep - 2; n >= 1; n--) if (fs.existsSync(archived(n))) fs.renameSync(archived(n), archived(n + 1));
        if (fs.existsSync(target)) fs.renameSync(target, archived(1));
      }
    } catch {
      // fichier ouvert ailleurs : on continue dans le fichier actuel
    }
    size = 0;
  }

  /** @param {string} text */
  function mask(text) {
    let out = censor(text, secrets);
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
    return out;
  }

  /** @param {Level} name @param {unknown[]} args */
  function write(name, args) {
    if (LEVELS[name] < LEVELS[level]) return;
    const line = `${stamp(now())} ${name.toUpperCase().padEnd(5)} ${mask(args.map(format).join(' '))}\n`;
    const bytes = Buffer.byteLength(line);
    try {
      if (size > 0 && size + bytes > maxBytes) rotate();
      fs.appendFileSync(target, line);
      size += bytes;
    } catch {
      // disque plein, dossier protégé… : le journal se tait
    }
  }

  rotate();
  return {
    file: target,
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    addSecret(secret) {
      if (secret) secrets.add(secret);
    },
  };
}

/** @type {Journal | null} */
let current = null;

/** Journal partagé du processus principal : silencieux tant que main.js ne l'a pas ouvert. @type {Journal} */
const journal = {
  get file() {
    return current?.file ?? '';
  },
  debug: (...args) => current?.debug(...args),
  info: (...args) => current?.info(...args),
  warn: (...args) => current?.warn(...args),
  error: (...args) => current?.error(...args),
  addSecret: (secret) => current?.addSecret(secret),
};

/** @param {Parameters<typeof createJournal>[0]} options */
function openJournal(options) {
  current = createJournal(options);
  return journal;
}

module.exports = { LEVELS, createJournal, openJournal, journal, stamp };
