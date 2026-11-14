'use strict';

// Linux : même forme que platform/windows. Pas de préférence de carte graphique ; raccourcis dans le menu des
// applications (.desktop) ; mesures du jeu au chantier D (en attendant, versions neutres de autre.js).
const autre = require('./autre');
const { linuxPhysicalCores } = require('./cpu');
const bureau = require('./linux-bureau');

module.exports = {
  ...autre,
  name: 'linux',
  physicalCores: () => linuxPhysicalCores(),
  shortcutsSupported: true,
  createShortcut: (instance) => bureau.createShortcut(instance),
  trayAvailable: () => bureau.trayAvailable(),
};
