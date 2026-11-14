// @ts-check
'use strict';

// Mémoire et processeur du jeu (processus java) sous Linux et macOS, même forme que windows/process-metrics.js :
// watch(pid, { intervalMs, onSample }) → { stop }, peak(pid) → octets ou null.
// Linux : lecture de /proc/<pid> (rien à lancer ; le noyau garde le pic : VmHWM).
// macOS : `ps` à chaque mesure ; le système ne donne pas le pic, il est retenu ici à partir des mesures.
const { execFile } = require('node:child_process');
const fs = require('node:fs');

/** Battements d'horloge par seconde de /proc/<pid>/stat (100 sur toutes les distributions courantes). */
const CLOCK_TICKS = 100;

/** Identifiant de processus sûr. @param {unknown} pid */
const safePid = (pid) => (Number.isInteger(pid) && /** @type {number} */ (pid) > 0 ? String(pid) : null);

/**
 * Linux : mémoire (VmRSS), pic (VmHWM) et temps processeur (utime + stime) d'un processus.
 * @param {string} status contenu de /proc/<pid>/status
 * @param {string} stat contenu de /proc/<pid>/stat
 * @returns {{ memory: number, peak: number, cpuMs: number } | null}
 */
function parseProc(status, stat) {
  const kb = (field) => Number(new RegExp(`^${field}:\\s*(\\d+)\\s*kB`, 'm').exec(status)?.[1]) * 1024;
  // Le nom du programme (2e champ) peut contenir des espaces et des parenthèses : on coupe après la dernière « ) ».
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(fields[11]) + Number(fields[12]); // utime (14e champ) + stime (15e)
  const memory = kb('VmRSS');
  const peak = kb('VmHWM');
  if (![memory, peak, ticks].every((n) => Number.isFinite(n) && n >= 0)) return null;
  return { memory, peak, cpuMs: (ticks * 1000) / CLOCK_TICKS };
}

/**
 * macOS : « rss temps » de `ps -o rss=,time=` (Ko ; temps [[jj-]hh:]mm:ss.cc).
 * @param {string} line
 * @returns {{ memory: number, cpuMs: number } | null}
 */
function parsePs(line) {
  const match = /^\s*(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/.exec(line);
  if (!match) return null;
  const [, rss, days = '0', hours = '0', minutes, seconds] = match;
  const cpuMs = Math.round((((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000);
  return { memory: Number(rss) * 1024, cpuMs };
}

/** Lecteurs remplaçables pour les tests. */
const linuxReader = (id) => {
  try {
    return parseProc(fs.readFileSync(`/proc/${id}/status`, 'utf8'), fs.readFileSync(`/proc/${id}/stat`, 'utf8'));
  } catch {
    return null; // processus terminé
  }
};

/** @param {string} id @param {typeof execFile} run @returns {Promise<{ memory: number, cpuMs: number } | null>} */
const macReader = (id, run = execFile) =>
  new Promise((resolve) => {
    run('/bin/ps', ['-o', 'rss=,time=', '-p', id], { timeout: 5_000 }, (error, stdout) => resolve(error ? null : parsePs(String(stdout))));
  });

/**
 * Mesures pour un système. `read(id)` renvoie { memory, peak?, cpuMs } (ou une promesse) ; sans `peak`, le pic est
 * le plus haut `memory` vu jusqu'ici.
 * @param {(id: string) => any} read
 */
function createMetrics(read) {
  /** @type {Map<string, number>} */
  const peaks = new Map();
  const sample = async (id) => {
    const s = await read(id);
    if (!s) return null;
    const peak = Math.max(s.peak ?? 0, s.memory, peaks.get(id) ?? 0);
    peaks.set(id, peak);
    return { memory: s.memory, peak, cpuMs: s.cpuMs };
  };
  return {
    supported: true,
    /** @param {number} pid @param {{ intervalMs?: number, onSample: (s: { memory: number, peak: number, cpuMs: number }) => void }} options */
    watch(pid, { intervalMs = 2000, onSample }) {
      const id = safePid(pid);
      if (!id) return { stop() {} };
      let stopped = false;
      const tick = () => sample(id).then((s) => { if (s && !stopped) onSample(s); }, () => {});
      tick();
      const timer = setInterval(tick, Math.max(500, Math.round(intervalMs)));
      timer.unref?.();
      return {
        stop() {
          stopped = true;
          clearInterval(timer);
        },
      };
    },
    /** @param {number} pid @returns {Promise<number | null>} */
    async peak(pid) {
      const id = safePid(pid);
      if (!id) return null;
      return (await sample(id).catch(() => null))?.peak ?? null;
    },
  };
}

module.exports = { parseProc, parsePs, createMetrics, linuxMetrics: () => createMetrics(linuxReader), macMetrics: () => createMetrics((id) => macReader(id)) };
