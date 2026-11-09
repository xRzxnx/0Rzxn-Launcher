'use strict';

// Import des instances d'autres launchers. Seuls les dossiers trouvés par une recherche peuvent être importés ;
// la source est seulement lue.
const { t } = require('../i18n');
const { app, dialog } = require('electron');
const path = require('node:path');
const importer = require('../core/importer');
const { text } = require('./handle');

function register({ handle, getWindow, services, instances, runTask }) {
  const scanned = new Map(); // chemin → nom du launcher (instance) ou 'world'
  const pickFolder = async (title, defaultPath) => {
    const result = await dialog.showOpenDialog(getWindow(), { title, defaultPath, properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  };
  const instancesFrom = (dir) => {
    const found = importer.scanInstances(dir);
    const imported = new Set(instances.list().map((i) => i.importedFrom?.path).filter(Boolean));
    for (const item of found.instances) {
      scanned.set(item.path, found.launcher);
      item.imported = imported.has(item.path);
    }
    return found;
  };
  handle('import:scanInstances', () => instancesFrom(importer.defaultInstancesDir(app.getPath('appData'))));
  handle('import:pickInstances', async () => {
    const dir = await pickFolder(t('ipc.dossier_instances_un_autre_launcher'), importer.defaultInstancesDir(app.getPath('appData')));
    return dir ? instancesFrom(dir) : null;
  });
  handle('import:instance', (dir) => {
    const source = text(dir);
    const launcher = scanned.get(source);
    if (!launcher) throw new Error(t('ipc.instance_inconnue_relance_la_recherche'));
    return runTask(t('ipc.import_de_2', { source: path.basename(source) }), (onProgress) =>
      importer.importInstance({ instances, dir: source, defaults: services.settings.defaults(), launcher, onProgress }),
    );
  });
}

module.exports = { register };
