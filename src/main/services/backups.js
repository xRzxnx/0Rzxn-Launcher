'use strict';

const { t } = require('../i18n');
const path = require('node:path');
const worlds = require('../core/worlds');

// Sauvegarde automatique des mondes avant une opération risquée (reason : modpack, version, loader, launch).
function worldsToBackUp(instance, reason) {
  const s = instance.settings;
  if (reason === 'launch') {
    if (s.backupLaunch === 'never') return null;
    return s.backupLaunch === 'hardcore' ? (w) => w.hardcore : () => true;
  }
  return s.backupAuto ? () => true : null;
}

/** `runTask` : la tâche longue unique (services/tasks.js) ; `trash` : corbeille de Windows. */
function createBackups({ dirs, instances, runTask, trash }) {
  // Renvoie null si rien n'était à faire ; lève une erreur si la copie échoue (l'opération est alors arrêtée).
  const autoBackup = (instance, reason, onProgress, signal) => {
    const filter = worldsToBackUp(instance, reason);
    const gameDir = instances.gameDir(instance.id);
    if (!filter || !worlds.scanWorlds(gameDir).some(filter)) return null;
    const label = t('ipc.sauvegarde_des_mondes');
    return worlds.backupAll({
      gameDir, backupDir: path.join(dirs.backups, instance.id), reason, keep: instance.settings.backupKeep, trash, filter, signal,
      onProgress: (p) => onProgress({ ...p, label: p.world ? t('ipc.sauvegarde_de', { name: p.world }) : label }),
    });
  };

  /** Sauvegarde automatique seule, comme tâche : { backupError } si elle échoue, null sinon. */
  const backupBefore = async (instance, reason) => {
    if (!worldsToBackUp(instance, reason) || !worlds.scanWorlds(instances.gameDir(instance.id)).some(worldsToBackUp(instance, reason))) return null;
    try {
      await runTask(t('ipc.sauvegarde_des_mondes'), (onProgress, signal) => autoBackup(instance, reason, onProgress, signal), {
        cancellable: true,
        kind: 'worlds-auto-backup',
        instanceId: instance.id,
        params: { reason },
      });
      return null;
    } catch (error) {
      return { backupError: error.message };
    }
  };

  /** Dossier des sauvegardes d'une instance (lève une erreur si elle n'existe pas). */
  const backupDirOf = (id) => path.join(dirs.backups, instances.get(id).id);

  return { autoBackup, backupBefore, backupDirOf };
}

module.exports = { worldsToBackUp, createBackups };
