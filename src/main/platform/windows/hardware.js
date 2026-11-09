'use strict';

// Composants du PC lus auprès de Windows (PowerShell).
const { execFile } = require('node:child_process');

/** Cœurs physiques ; `os.cpus()` compte les cœurs logiques. Null si Windows ne répond pas. */
function physicalCores() {
  const script = '(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
      const cores = Number.parseInt(stdout, 10);
      resolve(!error && cores > 0 ? cores : null);
    });
  });
}

module.exports = { physicalCores };
