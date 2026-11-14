'use strict';

// Linux : zone de notification disponible ou non, raccourci d'instance dans le menu des applications (fichier .desktop).
const { t } = require('../i18n');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Les icônes de notification passent par le service StatusNotifier (KDE, Xfce, Cinnamon, GNOME avec l'extension
 * AppIndicator). Sans lui, Electron crée l'icône mais rien ne s'affiche. Si `gdbus` manque, on ne peut pas savoir : oui.
 * @param {{ run?: typeof execFile }} [options]
 * @returns {Promise<boolean>}
 */
function trayAvailable({ run = execFile } = {}) {
  const args = ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
    '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.kde.StatusNotifierWatcher'];
  return new Promise((resolve) => {
    run('gdbus', args, { timeout: 3_000 }, (error, stdout) => {
      if (error) resolve(error.code === 'ENOENT');
      else resolve(!/\bfalse\b/.test(String(stdout)));
    });
  });
}

/** Argument de la ligne Exec= d'un fichier .desktop : entre guillemets, avec " ` $ \ échappés. */
const quoteExec = (arg) => `"${String(arg).replace(/(["`$\\])/g, '\\$1')}"`;

/** Valeur d'une ligne « clé=valeur » : une seule ligne, sans caractères de contrôle. */
const oneLine = (text) => [...String(text)].map((c) => (c < ' ' || c === '\u007f' ? ' ' : c)).join('').replace(/ {2,}/g, ' ').trim();

/**
 * Contenu du fichier .desktop d'une instance.
 * @param {{ name: string, comment: string, command: string[], icon: string }} entry
 */
function desktopEntry({ name, comment, command, icon }) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${oneLine(name)}`,
    `Comment=${oneLine(comment)}`,
    `Exec=${command.map(quoteExec).join(' ')}`,
    `Icon=${oneLine(icon)}`,
    'Terminal=false',
    'Categories=Game;',
    '',
  ].join('\n');
}

/**
 * Commande qui lance l'instance : l'AppImage elle-même (son chemin réel est dans $APPIMAGE, process.execPath
 * pointe dans un dossier monté qui change à chaque lancement), l'exécutable installé, ou Electron + le projet.
 */
function launchCommand(instanceId, { env = process.env, execPath = process.execPath, isPackaged, appPath }) {
  const target = env.APPIMAGE || execPath;
  return [target, ...(isPackaged ? [] : [appPath]), `--launch=${instanceId}`];
}

/**
 * Crée (ou remplace) ~/.local/share/applications/0rzxn-<instance>.desktop et renvoie son nom de fichier.
 * L'icône du launcher est copiée dans ses données : le chemin de l'AppImage montée ne dure pas.
 */
function createShortcut(instance, { home = os.homedir(), env = process.env } = {}) {
  const { app } = require('electron');
  const dataHome = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
  const dir = path.join(dataHome, 'applications');
  const icon = path.join(app.getPath('userData'), 'icone.png');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), icon);
    const safeId = instance.id.replace(/[^a-z0-9-]/gi, '') || 'instance';
    const file = path.join(dir, `0rzxn-${safeId}.desktop`);
    const command = launchCommand(instance.id, { env, isPackaged: app.isPackaged, appPath: app.getAppPath() });
    fs.writeFileSync(file, desktopEntry({ name: instance.name, comment: t('ipc.lancer_avec_0rzxn_launcher', { name: instance.name }), command, icon }), { mode: 0o755 });
    return path.basename(file);
  } catch {
    throw new Error(t('ipc.raccourci_linux_impossible'));
  }
}

module.exports = { trayAvailable, desktopEntry, launchCommand, createShortcut };
