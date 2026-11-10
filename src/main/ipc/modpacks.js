'use strict';

// Modpacks : installation depuis Modrinth ou un fichier .mrpack, mise à jour, export.
const { t } = require('../i18n');
const { app, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const modpacks = require('../core/modpacks');
const modrinth = require('../core/modrinth');
const { text } = require('./handle');

function register({ handle, getWindow, services, dirs, instances, runTask, backups, trash, notRunning }) {
  const installFromBuffer = (label, buffer, source, kind) =>
    runTask(label, (onProgress) => modpacks.installPack({ instances, buffer, defaults: services.settings.defaults(), source, onProgress }), { kind, params: source });

  handle('modpacks:install', async (projectId, versionId, meta) => {
    const id = text(projectId);
    const chosen = text(versionId) || (await modrinth.versions(id, {}))[0]?.id;
    if (!chosen) throw new Error(t('ipc.ce_modpack_aucune_version_telechargeable'));
    const { buffer } = await modpacks.downloadPack(dirs, chosen);
    return installFromBuffer(t('ipc.installation_de', { title: text(meta?.title) || 'modpack' }), buffer, {
      projectId: id,
      versionId: chosen,
      title: text(meta?.title) || undefined,
      icon: text(meta?.icon) || null,
    }, 'modpack-install');
  });
  handle('modpacks:import', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: t('ipc.importer_un_modpack'),
      properties: ['openFile'],
      filters: [{ name: t('ipc.modpack_modrinth'), extensions: ['mrpack'] }],
    });
    if (result.canceled) return null;
    const buffer = await fs.promises.readFile(result.filePaths[0]);
    return installFromBuffer(t('ipc.import_de', { filePaths: path.basename(result.filePaths[0]) }), buffer, null, 'modpack-import');
  });
  handle('modpacks:checkUpdate', (id) => modpacks.checkUpdate(instances.get(text(id))));
  handle('modpacks:update', async (id, versionId, options) => {
    notRunning(text(id), t('ipc.mettre_jour_le_modpack'));
    const instance = instances.get(text(id));
    if (options?.skipBackup !== true) {
      const failed = await backups.backupBefore(instance, 'modpack');
      if (failed) return failed;
    }
    const { buffer } = await modpacks.downloadPack(dirs, text(versionId));
    return runTask(t('ipc.mise_jour_de', { name: instance.name }), (onProgress) =>
      modpacks.updatePack({ instances, instanceId: instance.id, buffer, source: { versionId: text(versionId) }, trash, onProgress }),
    { kind: 'modpack-update', instanceId: instance.id, params: { versionId: text(versionId) } });
  });

  handle('instances:export', async (id, options) => {
    const instance = instances.get(text(id));
    const name = text(options?.name).trim() || instance.name;
    const version = text(options?.version).trim() || '1.0.0';
    const result = await dialog.showSaveDialog(getWindow(), {
      title: t('ipc.exporter_en_modpack'),
      defaultPath: path.join(app.getPath('desktop'), `${name.replace(/[\\/:*?"<>|]/g, '')}-${version}.mrpack`),
      filters: [{ name: t('ipc.modpack_modrinth'), extensions: ['mrpack'] }],
    });
    if (result.canceled) return null;
    const pack = await modpacks.exportPack({ instance, gameDir: instances.gameDir(instance.id), name, version, summary: text(options?.summary) });
    await fs.promises.writeFile(result.filePath, pack.buffer);
    return { file: result.filePath, referenced: pack.referenced, embedded: pack.embedded, size: pack.buffer.length };
  });
}

module.exports = { register };
