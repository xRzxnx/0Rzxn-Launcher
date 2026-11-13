// @ts-check
'use strict';

// Cœurs physiques sous Linux et macOS (`os.cpus()` compte les cœurs logiques). Null si le système ne répond pas.
const { execFile } = require('node:child_process');
const fs = require('node:fs');

/**
 * Linux : couples uniques (processeur physique, cœur) de /proc/cpuinfo.
 * Sans ces champs (certaines puces ARM, machines virtuelles) : null.
 * @param {string} cpuinfo
 */
function coresFromCpuinfo(cpuinfo) {
  const pairs = new Set();
  for (const block of cpuinfo.split(/\n\s*\n/)) {
    const physical = /^physical id\s*:\s*(\d+)/m.exec(block)?.[1];
    const core = /^core id\s*:\s*(\d+)/m.exec(block)?.[1];
    if (physical !== undefined && core !== undefined) pairs.add(`${physical}:${core}`);
  }
  return pairs.size || null;
}

/** @param {{ read?: () => string }} [options] */
async function linuxPhysicalCores({ read = () => fs.readFileSync('/proc/cpuinfo', 'utf8') } = {}) {
  try {
    return coresFromCpuinfo(read());
  } catch {
    return null;
  }
}

/** macOS : `sysctl -n hw.physicalcpu`. @param {{ run?: typeof execFile }} [options] */
function macPhysicalCores({ run = execFile } = {}) {
  return new Promise((resolve) => {
    run('/usr/sbin/sysctl', ['-n', 'hw.physicalcpu'], { timeout: 5_000 }, (error, stdout) => {
      const cores = Number.parseInt(String(stdout), 10);
      resolve(!error && cores > 0 ? cores : null);
    });
  });
}

module.exports = { coresFromCpuinfo, linuxPhysicalCores, macPhysicalCores };
