'use strict';

// Mondes et sauvegardes.
const { t } = require('../i18n');
const { shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const versions = require('../core/versions');
const worlds = require('../core/worlds');
const { text } = require('./handle');

function register({ handle, dirs, instances, runTask, backups, trash, notRunning }) {
  const { backupDirOf } = backups;
  // Ordre de sortie des versions (manifeste Mojang déjà chargé) : sert à repérer un monde enregistré par une version plus récente.
  const releaseOrder = async () => {
    try {
      const manifest = await versions.getManifest(dirs);
      return new Map(manifest.versions.map((v) => [v.id, Date.parse(v.releaseTime)]));
    } catch {
      return new Map();
    }
  };
  handle('worlds:list', async (id) => {
    const instance = instances.get(text(id));
    const [list, backups, order] = await Promise.all([worlds.listWorlds(instances.gameDir(instance.id)), worlds.listBackups(backupDirOf(instance.id)), releaseOrder()]);
    const mine = order.get(instance.version);
    return {
      worlds: list.map((w) => ({ ...w, newer: Boolean(mine && order.get(w.version) > mine) })),
      backups,
    };
  });
  handle('worlds:backup', (id, folder) => {
    const instance = instances.get(text(id));
    notRunning(instance.id, t('ipc.sauvegarder_un_monde'));
    return runTask(
      t('ipc.sauvegarde_de', { name: text(folder) }),
      (onProgress, signal) => worlds.backupWorld({ gameDir: instances.gameDir(instance.id), folder: text(folder), backupDir: backupDirOf(instance.id), signal, onProgress }),
      { cancellable: true, kind: 'world-backup', instanceId: instance.id, params: { folder: text(folder) } },
    );
  });
  handle('worlds:restore', (id, file, mode) => {
    const instance = instances.get(text(id));
    notRunning(instance.id, t('ipc.restaurer_un_monde'));
    const zipFile = worlds.backupFile(backupDirOf(instance.id), text(file));
    return runTask(
      t('ipc.restauration_de', { name: text(file) }),
      (onProgress, signal) => worlds.restoreWorld({ zipFile, gameDir: instances.gameDir(instance.id), mode: text(mode) === 'replace' ? 'replace' : 'beside', trash, signal, onProgress }),
      { cancellable: true, kind: 'world-restore', instanceId: instance.id, params: { file: text(file) } },
    );
  });
  handle('worlds:delete', (id, folder) => {
    notRunning(text(id), t('ipc.supprimer_un_monde'));
    return worlds.deleteWorld({ gameDir: instances.gameDir(text(id)), folder: text(folder), trash });
  });
  handle('worlds:deleteBackup', (id, file) => worlds.deleteBackup({ backupDir: backupDirOf(text(id)), file: text(file), trash }));
  handle('worlds:openFolder', async (id, folder) => {
    const gameDir = instances.gameDir(text(id));
    const dir = folder ? worlds.worldDir(gameDir, text(folder)) : path.join(gameDir, 'saves');
    fs.mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
  });
}

module.exports = { register };
