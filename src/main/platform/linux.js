'use strict';

// Linux : même forme que platform/windows. Pas de préférence de carte graphique ; raccourcis dans le menu des
// applications (.desktop) ; mesures du jeu par /proc.
const autre = require('./autre');
const { linuxPhysicalCores } = require('./cpu');
const bureau = require('./linux-bureau');
const { linuxMetrics } = require('./process-metrics-unix');

module.exports = {
  ...autre,
  name: 'linux',
  physicalCores: () => linuxPhysicalCores(),
  processMetrics: linuxMetrics(),
  shortcutsSupported: true,
  createShortcut: (instance) => bureau.createShortcut(instance),
  trayAvailable: () => bureau.trayAvailable(),
};
