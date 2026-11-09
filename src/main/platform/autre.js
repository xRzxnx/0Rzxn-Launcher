'use strict';

// macOS et Linux, en attendant la phase 9 : mêmes fonctions que platform/windows, sans effet.
const { t } = require('../i18n');

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
  createShortcut: () => {
    throw new Error(t('ipc.les_raccourcis_bureau_sont_disponibles'));
  },
  apresInstallation: async () => {},
};
