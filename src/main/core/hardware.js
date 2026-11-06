'use strict';

// Composants du PC : mémoire, processeur et carte graphique, lus une fois puis gardés en mémoire.
const { gb, t } = require('../i18n');
const { execFile } = require('node:child_process');
const os = require('node:os');
const gpu = require('./gpu');

let cache = null;

/** Cœurs physiques ; `os.cpus()` compte les cœurs logiques. Null si Windows ne répond pas. */
function physicalCores() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const script = '(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
      const cores = Number.parseInt(stdout, 10);
      resolve(!error && cores > 0 ? cores : null);
    });
  });
}

/** « NVIDIA GeForce RTX 3060 » → « RTX 3060 ». */
function shortGpuName(name) {
  return name
    .replace(/\((R|TM)\)/gi, '')
    .replace(/\b(NVIDIA|GeForce|AMD|ATI|Intel|Laptop GPU|Graphics)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** La carte active : une carte dédiée passe avant la puce du processeur. */
function mainGpu(gpus) {
  return gpus.find((g) => !g.integrated) ?? gpus[0] ?? null;
}

function describe({ totalGb, cpu, cores, threads, card }) {
  const coreLabel = cores ? t('hardware.urs', { cores }) : t('hardware.threads', { threads });
  const cardLabel = card ? (card.integrated ? t('hardware.carte_integree') : shortGpuName(card.name)) : null;
  return {
    summary: [gb(totalGb), coreLabel, cardLabel].filter(Boolean).join(' · '),
    detail: [cpu, coreLabel, card?.name, t('hardware.ram_total', { ram: gb(totalGb) })].filter(Boolean).join(' · '),
  };
}

async function loadHardware() {
  const [cores, gpus] = await Promise.all([physicalCores(), gpu.listGpus().catch(() => [])]);
  const list = os.cpus();
  const card = mainGpu(gpus);
  const totalGb = Math.round(os.totalmem() / 1024 ** 3);
  return { totalGb, cpu: list[0]?.model.trim() ?? null, cores, threads: list.length, card };
}

/** Seuls les faits sont gardés en mémoire : les libellés suivent la langue du moment. */
async function readHardware() {
  cache ??= loadHardware();
  const facts = await cache;
  return { totalGb: facts.totalGb, integrated: Boolean(facts.card?.integrated), ...describe(facts) };
}

module.exports = { readHardware, shortGpuName, mainGpu, describe };
