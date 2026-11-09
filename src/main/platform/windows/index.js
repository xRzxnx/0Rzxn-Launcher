'use strict';

// Windows : carte graphique (registre), composants du PC (PowerShell).
const gpu = require('./gpu');
const { physicalCores } = require('./hardware');

module.exports = {
  name: 'windows',
  gpu,
  physicalCores,
};
