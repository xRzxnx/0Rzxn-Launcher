'use strict';

// Systèmes sans implémentation (BSD…) et base de linux.js / mac.js : mêmes fonctions que platform/windows, sans effet.
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
  processMetrics: { supported: false, watch: () => ({ stop() {} }), peak: async () => null },
  /** Le bouton « Raccourci » n'est affiché que si le système en a. */
  shortcutsSupported: false,
  /** Zone de notification affichable (Linux : selon le bureau). */
  trayAvailable: async () => true,
  createShortcut: () => {
    throw new Error(t('ipc.les_raccourcis_bureau_sont_disponibles'));
  },
  apresInstallation: async () => {},
};
