// @ts-check
'use strict';

// Mémoire et processeur du jeu (processus java.exe) sous Windows, sans module natif :
// - fenêtre ouverte : une seule commande PowerShell qui tourne pendant la partie et donne une mesure toutes les 2 s ;
// - fenêtre fermée : rien ne tourne ; le pic de mémoire est relu de temps en temps par une commande courte
//   (Windows garde lui-même le pic : PeakWorkingSet64).
const { spawn } = require('node:child_process');

const ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/** Mesures écrites par PowerShell : « mémoire pic tempsCPUms » sur une ligne. @param {string} pid @param {number} ms */
const watchScript = (pid, ms) =>
  `$p = Get-Process -Id ${pid} -ErrorAction Stop; while (-not $p.HasExited) { $p.Refresh(); ` +
  `[Console]::Out.WriteLine("$($p.WorkingSet64) $($p.PeakWorkingSet64) $([long]$p.TotalProcessorTime.TotalMilliseconds)"); ` +
  `Start-Sleep -Milliseconds ${ms} }`;

/** @param {string} line @returns {{ memory: number, peak: number, cpuMs: number } | null} */
function parseSample(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const [memory, peak, cpuMs] = parts.map(Number);
  if (![memory, peak, cpuMs].every((n) => Number.isFinite(n) && n >= 0)) return null;
  return { memory, peak, cpuMs };
}

/** Identifiant de processus sûr à mettre dans une commande. @param {unknown} pid */
const safePid = (pid) => (Number.isInteger(pid) && /** @type {number} */ (pid) > 0 ? String(pid) : null);

/**
 * Suit le processus `pid` : `onSample({ memory, peak, cpuMs })` à chaque mesure. Renvoie `stop()`.
 * @param {number} pid
 * @param {{ intervalMs?: number, onSample: (s: { memory: number, peak: number, cpuMs: number }) => void, spawnFn?: typeof spawn }} options
 */
function watchProcess(pid, { intervalMs = 2000, onSample, spawnFn = spawn }) {
  const id = safePid(pid);
  if (!id) return { stop() {} };
  let child;
  try {
    child = spawnFn('powershell.exe', [...ARGS, watchScript(id, Math.max(500, Math.round(intervalMs)))], { windowsHide: true });
  } catch {
    return { stop() {} };
  }
  let rest = '';
  child.stdout?.on('data', (chunk) => {
    const lines = (rest + chunk).split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) {
      const sample = parseSample(line);
      if (sample) onSample(sample);
    }
  });
  child.on('error', () => {}); // PowerShell absent ou bloqué : pas de mesures, rien d'autre ne change
  return {
    stop() {
      if (child.exitCode == null && !child.killed) child.kill();
    },
  };
}

/**
 * Pic de mémoire du processus (octets), ou null s'il ne répond plus.
 * @param {number} pid @param {{ spawnFn?: typeof spawn, timeoutMs?: number }} [options]
 * @returns {Promise<number | null>}
 */
function peakMemory(pid, { spawnFn = spawn, timeoutMs = 10_000 } = {}) {
  const id = safePid(pid);
  if (!id) return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawnFn('powershell.exe', [...ARGS, `(Get-Process -Id ${id} -ErrorAction Stop).PeakWorkingSet64`], { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => {
      out += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const value = Number(out.trim());
      resolve(Number.isFinite(value) && value > 0 ? value : null);
    });
  });
}

module.exports = { watchProcess, peakMemory, parseSample, watchScript };
