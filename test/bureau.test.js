'use strict';

// Intégration au bureau hors Windows : raccourcis .desktop et zone de notification sous Linux, icône « Template » sous macOS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { electron, tempRoot } = require('./helpers/faux-electron');
const { t: tr } = require('../src/main/i18n');
const bureau = require('../src/main/platform/linux-bureau');
const { platformFor } = require('../src/main/platform');
const { LauncherTray, trayIcon } = require('../src/main/tray');

test('.desktop : guillemets et caractères spéciaux échappés, une ligne par clé', () => {
  const text = bureau.desktopEntry({
    name: 'Survie "hard"\ncore',
    comment: 'Lancer Survie',
    command: ['/home/ana/Apps/0Rzxn $1.AppImage', '--launch=survie'],
    icon: '/home/ana/.config/0Rzxn_ Launcher/icone.png',
  });
  const lines = text.split('\n');
  assert.equal(lines[0], '[Desktop Entry]');
  assert.ok(lines.includes('Name=Survie "hard" core'));
  assert.ok(lines.includes('Exec="/home/ana/Apps/0Rzxn \\$1.AppImage" "--launch=survie"'));
  assert.ok(lines.includes('Categories=Game;'));
  assert.ok(lines.includes('Icon=/home/ana/.config/0Rzxn_ Launcher/icone.png'));
});

test('.desktop : l’AppImage elle-même, l’exécutable installé, ou Electron + le projet', () => {
  assert.deepEqual(bureau.launchCommand('survie', { env: { APPIMAGE: '/home/ana/0Rzxn.AppImage' }, execPath: '/tmp/.mount_x/0rzxn', isPackaged: true }), ['/home/ana/0Rzxn.AppImage', '--launch=survie']);
  assert.deepEqual(bureau.launchCommand('survie', { env: {}, execPath: '/opt/0rzxn/0rzxn', isPackaged: true }), ['/opt/0rzxn/0rzxn', '--launch=survie']);
  assert.deepEqual(bureau.launchCommand('survie', { env: {}, execPath: '/proj/electron', isPackaged: false, appPath: '/proj' }), ['/proj/electron', '/proj', '--launch=survie']);
});

test('raccourci Linux : fichier dans le menu des applications, icône copiée, remplacé au second appel', (t) => {
  const root = tempRoot(t);
  electron.reset(root);
  const home = path.join(root, 'maison');
  const name = bureau.createShortcut({ id: 'survie', name: 'Survie' }, { home, env: {} });
  assert.equal(name, '0rzxn-survie.desktop');
  const file = path.join(home, '.local', 'share', 'applications', name);
  assert.match(fs.readFileSync(file, 'utf8'), /--launch=survie/);
  assert.ok(fs.existsSync(path.join(electron.app.getPath('userData'), 'icone.png')));
  bureau.createShortcut({ id: 'survie', name: 'Survie 2' }, { home, env: {} });
  assert.match(fs.readFileSync(file, 'utf8'), /Name=Survie 2/);
  // Identifiant douteux : jamais de chemin hors du dossier.
  assert.equal(bureau.createShortcut({ id: '../../x', name: 'X' }, { home, env: {} }), '0rzxn-x.desktop');
  // XDG_DATA_HOME suivi s'il est absolu.
  bureau.createShortcut({ id: 'pvp', name: 'PvP' }, { home, env: { XDG_DATA_HOME: path.join(root, 'xdg') } });
  assert.ok(fs.existsSync(path.join(root, 'xdg', 'applications', '0rzxn-pvp.desktop')));
});

test('zone de notification Linux : StatusNotifier présent, absent, ou gdbus introuvable', async () => {
  const runWith = (error, stdout) => (file, args, options, done) => done(error, stdout);
  assert.equal(await bureau.trayAvailable({ run: runWith(null, '(true,)\n') }), true);
  assert.equal(await bureau.trayAvailable({ run: runWith(null, '(false,)\n') }), false);
  assert.equal(await bureau.trayAvailable({ run: runWith(Object.assign(new Error('absent'), { code: 'ENOENT' }), '') }), true);
  assert.equal(await bureau.trayAvailable({ run: runWith(Object.assign(new Error('timeout'), { code: 1 }), '') }), false);
});

test('raccourcis et zone de notification selon le système', async () => {
  assert.equal(platformFor('win32').shortcutsSupported, true);
  assert.equal(platformFor('linux').shortcutsSupported, true);
  assert.equal(platformFor('darwin').shortcutsSupported, false);
  assert.throws(() => platformFor('darwin').createShortcut({ id: 'a', name: 'A' }), { message: tr('ipc.les_raccourcis_bureau_sont_disponibles') });
  assert.equal(await platformFor('darwin').trayAvailable(), true);
});

test('icône de la zone de notification : version Template sous macOS, fichiers présents', () => {
  for (const [platform, playing, name] of [['win32', false, 'tray.png'], ['linux', true, 'tray-playing.png'], ['darwin', false, 'trayTemplate.png'], ['darwin', true, 'tray-playingTemplate.png']]) {
    const { file } = trayIcon(playing, platform);
    assert.equal(path.basename(file), name);
    assert.ok(fs.existsSync(file), file);
    assert.ok(fs.existsSync(file.replace(/\.png$/, '@2x.png')), file);
  }
});

test('zone de notification indisponible : icône retirée et jamais recréée', (t) => {
  electron.reset(tempRoot(t));
  const tray = new LauncherTray({ launches: { run: null }, instances: { list: () => [] } });
  tray.setEnabled(true);
  assert.equal(tray.enabled, true);
  tray.setAvailable(false);
  assert.equal(tray.enabled, false);
  tray.setEnabled(true);
  assert.equal(tray.enabled, false);
  assert.equal(electron.calls.trays.length, 1);
});
