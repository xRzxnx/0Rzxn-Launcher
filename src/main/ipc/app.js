'use strict';

// Launcher : informations, préférences d'interface, réglages, langue, Discord, mises à jour, bilan du mois.
const { t } = require('../i18n');
const { app, dialog, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('../core/net');
const discordConfig = require('../discord-config');
const { clientId: MICROSOFT_CLIENT_ID } = require('../microsoft-config');
const { launchArgument, text } = require('./handle');

// Bilan mensuel : le processus principal vérifie que le contenu reçu est bien un PNG de taille raisonnable.
const RECAP_MAX_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function register({ handle, getWindow, services, dirs, appShell, applyLanguage, launches }) {
  const { tray, updates } = appShell;

  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    root: dirs.root,
    microsoftReady: Boolean(MICROSOFT_CLIENT_ID),
    discordReady: Boolean(discordConfig.clientId),
  }));
  handle('system:memory', () => ({ totalGb: os.totalmem() / 1024 ** 3, freeGb: os.freemem() / 1024 ** 3 }));

  // Raccourci bureau : « --launch=<instance> » lance directement l'instance.
  let pendingLaunch = launchArgument(process.argv);
  handle('ui:get', () => {
    // Fenêtre recréée pendant ou juste après une partie : elle revient sur l'écran où elle était.
    const ui = { ...services.settings.ui(), pendingLaunch, reopenView: launches.takeReopenView() };
    pendingLaunch = null;
    return ui;
  });
  handle('ui:set', (patch) => {
    // L'écran affiché reste en mémoire seulement (pour rouvrir la fenêtre au même endroit), sans écrire les réglages.
    const { view, ...rest } = patch ?? {};
    if (typeof view === 'string') launches.view = view.slice(0, 40);
    return Object.keys(rest).length ? services.settings.setUi(rest) : services.settings.ui();
  });

  handle('stats:saveRecapImage', async (month, bytes) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text(month))) throw new Error(t('ipc.mois_invalide'));
    if (!(bytes instanceof Uint8Array) || bytes.length < 33 || bytes.length > RECAP_MAX_BYTES) throw new Error(t('ipc.image_refusee_taille_inattendue'));
    const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
    const header = png.subarray(12, 16).toString('latin1') === 'IHDR';
    const tooBig = png.readUInt32BE(16) > 4096 || png.readUInt32BE(20) > 4096;
    if (!png.subarray(0, 8).equals(PNG_SIGNATURE) || !header || tooBig) throw new Error(t('ipc.image_refusee_ce_est_pas'));
    const result = await dialog.showSaveDialog(getWindow(), {
      title: t('ipc.enregistrer_le_bilan_du_mois'),
      defaultPath: path.join(app.getPath('pictures'), t('ipc.bilan_png', { month })),
      filters: [{ name: t('ipc.image_png'), extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.promises.writeFile(result.filePath, png);
    return result.filePath;
  });

  handle('launcher:openFolder', async () => {
    const error = await shell.openPath(dirs.root);
    if (error) throw new Error(error);
  });

  handle('settings:get', () => services.settings.defaults());
  handle('settings:update', (patch) => services.settings.setDefaults(patch ?? {}));
  handle('dialog:pickJava', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: t('ipc.choisir_un_java'),
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : [],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // ---------- Réglages du launcher : thème, Discord, zone de notification, mises à jour ----------
  handle('update:state', () => ({ ...updates.state }));
  handle('update:check', () => updates.check({ manual: true }));
  handle('update:install', () => updates.install());

  handle('launcher:get', () => services.settings.launcher());
  // La langue change sans redémarrer : messages d'erreur, dialogues et zone de notification suivent aussitôt.
  handle('launcher:setLanguage', (language) => {
    services.settings.setLauncher({ language });
    const next = applyLanguage();
    tray.refresh();
    return next;
  });
  handle('launcher:set', (patch) => {
    const channel = services.settings.launcher().updateChannel;
    const prefs = services.settings.setLauncher(patch ?? {});
    if (prefs.updateChannel !== channel) updates.channelChanged();
    net.configure(prefs.downloads);
    tray.setEnabled(prefs.tray);
    appShell.queueDiscord();
    return prefs;
  });
  handle('discord:status', () => appShell.discordStatus());
}

module.exports = { register };
