'use strict';

// Linux : même forme que platform/windows. Pas de préférence de carte graphique ; le reste arrive chantier par chantier
// (raccourcis .desktop, mesures du jeu), en attendant ce sont les versions neutres de autre.js.
const autre = require('./autre');
const { linuxPhysicalCores } = require('./cpu');

module.exports = {
  ...autre,
  name: 'linux',
  physicalCores: () => linuxPhysicalCores(),
};
