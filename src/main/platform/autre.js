'use strict';

// macOS et Linux, en attendant la phase 9 : mêmes fonctions que platform/windows, sans effet.

const gpu = {
  supported: false,
  listGpus: async () => [],
  preference: async () => null,
  setHighPerformance: async () => {},
  clearPreference: async () => {},
};

module.exports = {
  name: 'autre',
  gpu,
  physicalCores: async () => null,
};
