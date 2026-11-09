'use strict';

// Lancement d'une instance, arrêt, état de la partie en cours.
const { t } = require('../i18n');
const { quickPlayTarget } = require('../services/launches');
const { text } = require('./handle');

function register({ handle, instances, launches, backups }) {
  handle('launch:start', async (id, options) => {
    const prepareOnly = options?.prepareOnly === true;
    if (!prepareOnly && options?.skipBackup !== true) {
      if (launches.session) throw new Error(t('ipc.une_partie_ou_une_installation'));
      const failed = await backups.backupBefore(instances.get(text(id)), 'launch');
      if (failed) return failed;
    }
    return launches.start(text(id), { verify: options?.verify === true, prepareOnly, quickPlay: prepareOnly ? null : quickPlayTarget(instances, text(id), options?.quickPlay) });
  });
  handle('launch:stop', () => launches.stop());
  handle('launch:state', () => launches.state());
}

module.exports = { register };
