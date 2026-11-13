'use strict';

// macOS : même forme que platform/windows. Ni préférence de carte graphique ni raccourci d'instance ;
// les mesures du jeu arrivent avec le chantier D, en attendant ce sont les versions neutres de autre.js.
const autre = require('./autre');
const { macPhysicalCores } = require('./cpu');

module.exports = {
  ...autre,
  name: 'mac',
  physicalCores: () => macPhysicalCores(),
};
