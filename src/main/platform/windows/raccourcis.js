'use strict';

// Raccourci bureau d'une instance : lance directement l'instance (« --launch=<instance> »).
const { t } = require('../../i18n');
const { app, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/** Crée (ou remplace) le raccourci et renvoie son nom de fichier. */
function createShortcut(instance) {
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
}

module.exports = { createShortcut };
