'use strict';

// macOS : même forme que platform/windows. Ni préférence de carte graphique ni raccourci d'instance ;
// mesures du jeu par `ps`.
const autre = require('./autre');
const { macPhysicalCores } = require('./cpu');
const { macMetrics } = require('./process-metrics-unix');

module.exports = {
  ...autre,
  name: 'mac',
  physicalCores: () => macPhysicalCores(),
  processMetrics: macMetrics(),
};
