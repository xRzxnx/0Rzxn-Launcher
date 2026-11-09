'use strict';

// Carte graphique : détection des GPU et préférence « Hautes performances » de Windows pour les java.exe du launcher.
// La préférence est celle de Paramètres › Affichage › Graphiques (clé UserGpuPreferences de l'utilisateur).
const { execFile } = require('node:child_process');

const KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
const HIGH = 'GpuPreference=2;';

let cache = null;

let runner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

/** Tests : remplace l'exécution de reg.exe et PowerShell. */
function setRunner(fn) {
  runner = fn;
  cache = null;
}

/** Puce intégrée au processeur ? D'après le fabricant (PCI) et le nom. */
function isIntegrated({ name, pnp }) {
  const vendor = /VEN_([0-9A-F]{4})/i.exec(pnp)?.[1]?.toUpperCase();
  if (vendor === '8086') return !/Arc\(TM\) [AB]\d|Arc [AB]\d/i.test(name); // Intel : intégrée sauf les Arc A/B
  if (vendor === '1002') return /Radeon\(TM\)( \d+M)? Graphics|Radeon Graphics|Vega \d+ Graphics/i.test(name);
  return false;
}

/** Cartes graphiques physiques (les écrans virtuels et le bureau à distance sont ignorés). */
async function listGpus() {
  if (cache) return cache;
  const script = 'Get-CimInstance Win32_VideoController | Select-Object Name,PNPDeviceID | ConvertTo-Json -Compress';
  const out = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const list = [].concat(JSON.parse(out.trim() || '[]'));
  cache = list
    .filter((g) => /^PCI\\/i.test(g.PNPDeviceID ?? ''))
    .map((g) => ({ name: g.Name.trim(), pnp: g.PNPDeviceID }))
    .map((g) => ({ name: g.name, integrated: isIntegrated(g) }));
  return cache;
}

/** Préférence enregistrée pour un exécutable : 'high', 'saving', 'auto' ou null (aucune). */
async function preference(exe) {
  try {
    const out = await runner('reg.exe', ['query', KEY, '/v', exe]);
    const value = /REG_SZ\s+(.*)$/m.exec(out)?.[1] ?? '';
    const pref = /GpuPreference=(\d)/.exec(value)?.[1];
    return pref === '2' ? 'high' : pref === '1' ? 'saving' : 'auto';
  } catch {
    return null; // valeur absente
  }
}

async function setHighPerformance(exes) {
  for (const exe of exes) await runner('reg.exe', ['add', KEY, '/v', exe, '/t', 'REG_SZ', '/d', HIGH, '/f']);
}

/** Retire uniquement les valeurs écrites par le launcher (« Hautes performances »). */
async function clearPreference(exes) {
  for (const exe of exes) {
    if ((await preference(exe)) === 'high') await runner('reg.exe', ['delete', KEY, '/v', exe, '/f']);
  }
}

module.exports = { supported: true, KEY, HIGH, setRunner, isIntegrated, listGpus, preference, setHighPerformance, clearPreference };
