'use strict';

// Versions, loaders et instances : création, modification, copie, fond, suppression, raccourci, dossier.
const { t } = require('../i18n');
const { app, dialog, protocol, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const versions = require('../core/versions');
const { availableLoaders } = require('../core/loaders');
const { text } = require('./handle');

function register({ handle, getWindow, services, dirs, instances, launches, backups, notRunning }) {
  handle('versions:list', () => versions.listVersions(dirs));
  handle('versions:details', (id) => versions.versionDetails(dirs, text(id)));
  handle('loaders:available', (mc) => availableLoaders(text(mc)));

  handle('instances:list', () => instances.list());
  handle('instances:create', (data) => instances.create(data ?? {}, services.settings.defaults()));
  // Changer de version ou de loader convertit les mondes sans retour possible : ils sont sauvegardés avant.
  handle('instances:update', async (id, patch, options) => {
    if (launches.run?.instanceId === id && patch?.version) throw new Error(t('ipc.impossible_de_changer_de_version'));
    const current = instances.get(text(id));
    const loaderChanged = patch?.loader !== undefined && (patch.loader !== current.loader || (patch.loaderVersion ?? null) !== (current.loaderVersion ?? null));
    const reason = typeof patch?.version === 'string' && patch.version !== current.version ? 'version' : loaderChanged ? 'loader' : null;
    if (reason && options?.skipBackup !== true) {
      const failed = await backups.backupBefore(current, reason);
      if (failed) return failed;
    }
    return instances.update(text(id), patch ?? {});
  });
  handle('instances:duplicate', (id, name) => {
    notRunning(text(id), t('ipc.action_duplicate'));
    return instances.duplicate(text(id), text(name));
  });
  handle('instances:pickBackground', async (id) => {
    instances.get(text(id));
    const result = await dialog.showOpenDialog(getWindow(), { title: t('ipc.choisir_une_image_de_fond'), filters: [{ name: t('ipc.image_png_jpeg_webp'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }], properties: ['openFile'] });
    const file = result.filePaths?.[0];
    if (result.canceled || !file) return null;
    return instances.importBackground(text(id), file);
  });
  handle('instances:cleanBackground', (id) => instances.cleanBackgroundFiles(text(id)));
  // Fonds d'instance : fond://<instance>/<fichier>, seulement les images « fond-… » du dossier de l'instance.
  protocol.handle('fond', async (request) => {
    try {
      const url = new URL(request.url);
      const name = url.pathname.replace(/^\//, '');
      const file = instances.backgroundFile(url.hostname, name);
      if (!file) return new Response('', { status: 404 });
      const type = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[path.extname(name).slice(1)];
      return new Response(await fs.promises.readFile(file), { headers: { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' } });
    } catch {
      return new Response('', { status: 404 });
    }
  });
  // Suppression = corbeille Windows : on peut toujours récupérer ses mondes.
  handle('instances:delete', async (id) => {
    notRunning(text(id), t('ipc.action_delete'));
    instances.get(text(id));
    await shell.trashItem(instances.dir(text(id)));
    if (services.settings.ui().selectedId === id) services.settings.setUi({ selectedId: null });
  });
  handle('instances:shortcut', (id) => {
    if (process.platform !== 'win32') throw new Error(t('ipc.les_raccourcis_bureau_sont_disponibles'));
    const instance = instances.get(text(id));
    const safeName = instance.name.replace(/[\\/:*?"<>|]/g, '').trim() || instance.id;
    const file = path.join(app.getPath('desktop'), `${safeName} (0Rzxn_).lnk`);
    const options = {
      target: process.execPath,
      // En développement, Electron a besoin du dossier du projet avant les arguments.
      args: app.isPackaged ? `--launch=${instance.id}` : `"${app.getAppPath()}" --launch=${instance.id}`,
      cwd: path.dirname(process.execPath),
      description: t('ipc.lancer_avec_0rzxn_launcher', { name: instance.name }),
      icon: process.execPath,
      iconIndex: 0,
    };
    if (!shell.writeShortcutLink(file, fs.existsSync(file) ? 'replace' : 'create', options)) {
      throw new Error(t('ipc.windows_pas_pu_creer_le'));
    }
    return path.basename(file);
  });
  handle('instances:openFolder', async (id) => {
    const dir = instances.gameDir(text(id));
    fs.mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
  });
}

module.exports = { register };
