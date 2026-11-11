'use strict';

// Windows : carte graphique (registre), composants du PC (PowerShell), raccourcis bureau, anciennes copies du launcher,
// mesures du processus du jeu (PowerShell).
const gpu = require('./gpu');
const { physicalCores } = require('./hardware');
const { createShortcut } = require('./raccourcis');
const processMetrics = require('./process-metrics');

module.exports = {
  name: 'windows',
  gpu,
  physicalCores,
  createShortcut,
  /** Mémoire et processeur du jeu (PowerShell). */
  processMetrics: { supported: true, watch: processMetrics.watchProcess, peak: processMetrics.peakMemory },
  /** Après une installation manuelle : retire les anciennes copies (chargé seulement à ce moment-là). */
  apresInstallation: (options) => require('./anciennes-versions').apresInstallation(options),
};
