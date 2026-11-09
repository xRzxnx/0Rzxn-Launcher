'use strict';

// Windows : carte graphique (registre), composants du PC (PowerShell), raccourcis bureau, anciennes copies du launcher.
const gpu = require('./gpu');
const { physicalCores } = require('./hardware');
const { createShortcut } = require('./raccourcis');

module.exports = {
  name: 'windows',
  gpu,
  physicalCores,
  createShortcut,
  /** Après une installation manuelle : retire les anciennes copies (chargé seulement à ce moment-là). */
  apresInstallation: (options) => require('./anciennes-versions').apresInstallation(options),
};
