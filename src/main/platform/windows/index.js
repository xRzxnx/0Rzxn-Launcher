'use strict';

// Windows : carte graphique (registre), composants du PC (PowerShell), anciennes copies du launcher.
const gpu = require('./gpu');
const { physicalCores } = require('./hardware');

module.exports = {
  name: 'windows',
  gpu,
  physicalCores,
  /** Après une installation manuelle : retire les anciennes copies (chargé seulement à ce moment-là). */
  apresInstallation: (options) => require('./anciennes-versions').apresInstallation(options),
};
