// @ts-check
'use strict';

const { SUPPORTED } = require('../i18n');
const { DEFAULT_SETTINGS, sanitizeSettings } = require('../core/instances');
const { readJson, writeJson } = require('../core/store');

// Réglages du launcher lui-même (Paramètres › Launcher).
// lightMode : le launcher se met en veille pendant une partie ; gpuHighPerformance : accord donné pour la carte dédiée.
// downloads : téléchargements simultanés au total et par serveur (Paramètres › Launcher › Téléchargements).
const LAUNCHER_DEFAULTS = { language: 'auto', accent: 'violet', discord: false, discordShowName: true, tray: true, closeToTray: false, lightMode: true, gpuHighPerformance: false, autoUpdate: true, downloads: { concurrency: 16, perHost: 8 } };
const ACCENTS = new Set(['violet', 'bleu', 'cyan', 'vert', 'ambre', 'rouge', 'rose']);

/** @param {any} value @param {number} min @param {number} max @param {number} fallback */
const bounded = (value, min, max, fallback) => (Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback);

function sanitizeLauncher(input, base = LAUNCHER_DEFAULTS) {
  const s = { ...base, downloads: { ...LAUNCHER_DEFAULTS.downloads, ...base.downloads } };
  if (input == null) return s;
  if (input.language === 'auto' || SUPPORTED.includes(input.language)) s.language = input.language;
  // Couleur d'accent : un thème prédéfini ou une couleur perso « #rrggbb ».
  if (ACCENTS.has(input.accent) || /^#[0-9a-f]{6}$/i.test(input.accent ?? '')) s.accent = input.accent.toLowerCase();
  for (const key of ['discord', 'discordShowName', 'tray', 'closeToTray', 'lightMode', 'gpuHighPerformance', 'autoUpdate']) if (typeof input[key] === 'boolean') s[key] = input[key];
  if (input.downloads && typeof input.downloads === 'object') {
    s.downloads = {
      concurrency: bounded(input.downloads.concurrency, 1, 64, s.downloads.concurrency),
      perHost: bounded(input.downloads.perHost, 1, 32, s.downloads.perHost),
    };
  }
  return s;
}

/** settings.json : réglages par défaut des instances, réglages du launcher et petites préférences d'interface. */
function createSettingsStore(file) {
  const read = () => readJson(file, {});
  return {
    defaults: () => sanitizeSettings(read().defaults ?? DEFAULT_SETTINGS),
    setDefaults(patch) {
      const data = read();
      data.defaults = sanitizeSettings(patch, sanitizeSettings(data.defaults ?? DEFAULT_SETTINGS));
      writeJson(file, data);
      return data.defaults;
    },
    launcher: () => sanitizeLauncher(read().launcher),
    setLauncher(patch) {
      const data = read();
      data.launcher = sanitizeLauncher(patch, sanitizeLauncher(data.launcher));
      writeJson(file, data);
      return data.launcher;
    },
    ui: () => ({ selectedId: null, ...read().ui }),
    setUi(patch) {
      const data = read();
      const ui = { ...data.ui };
      if (typeof patch.selectedId === 'string' || patch.selectedId === null) ui.selectedId = patch.selectedId;
      // Groupes repliés dans la barre latérale, et date des derniers rapports de crash vus.
      if (Array.isArray(patch.collapsedGroups)) ui.collapsedGroups = patch.collapsedGroups.filter((g) => typeof g === 'string').slice(0, 100);
      if (Number.isFinite(patch.crashesSeenAt)) ui.crashesSeenAt = patch.crashesSeenAt;
      data.ui = ui;
      writeJson(file, data);
      return data.ui;
    },
  };
}

module.exports = { LAUNCHER_DEFAULTS, sanitizeLauncher, createSettingsStore };
