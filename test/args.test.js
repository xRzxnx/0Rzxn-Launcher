'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildArguments, splitUserArgs, supportsQuickPlay, serverTarget } = require('../src/main/core/args');

const feature = (name, value) => ({ rules: [{ action: 'allow', features: { [name]: true } }], value });

// Extrait d'un fichier de version moderne (1.20 et plus).
const MODERN = {
  id: '1.21.1',
  javaVersion: { majorVersion: 21 },
  arguments: {
    game: [
      '--username', '${auth_player_name}',
      '--version', '${version_name}',
      feature('has_custom_resolution', ['--width', '${resolution_width}', '--height', '${resolution_height}']),
      feature('has_quick_plays_support', ['--quickPlayPath', '${quickPlayPath}']),
      feature('is_quick_play_singleplayer', ['--quickPlaySingleplayer', '${quickPlaySingleplayer}']),
      feature('is_quick_play_multiplayer', ['--quickPlayMultiplayer', '${quickPlayMultiplayer}']),
      feature('is_quick_play_realms', ['--quickPlayRealms', '${quickPlayRealms}']),
    ],
    jvm: [
      { rules: [{ action: 'allow', os: { name: 'osx' } }], value: ['-XstartOnFirstThread'] },
      '-Djava.library.path=${natives_directory}',
      '-cp', '${classpath}',
    ],
  },
  logging: { client: { argument: '-Dlog4j.configurationFile=${path}' } },
};

// Extrait d'un fichier de version ancien (1.8.9).
const LEGACY = {
  id: '1.8.9',
  minecraftArguments: '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory}',
};

const VARS = {
  auth_player_name: '0Rzxn_',
  version_name: '1.21.1',
  game_directory: 'C:/jeu',
  natives_directory: 'C:/jeu/natives',
  classpath: 'a.jar;b.jar',
  launcher_name: '0Rzxn_ Launcher',
  launcher_version: '0.4.0',
  resolution_width: 854,
  resolution_height: 480,
};

const SETTINGS = { fullscreen: false, jvmPreset: 'g1', ram: 4, jvmArgs: '-Dfoo=bar "-Dchemin=C:\\a b"' };

test('buildArguments moderne : mémoire, arguments de l’utilisateur, logs et résolution', () => {
  const out = buildArguments({ version: MODERN, vars: VARS, settings: SETTINGS, loggingConfig: 'C:/logs/client.xml' });
  assert.equal(out.jvm[0], '-Xmx4096M');
  assert.equal(out.gc, 'g1');
  assert.ok(out.jvm.includes('-XX:+UseG1GC'));
  assert.ok(out.jvm.includes('-Dfoo=bar'));
  assert.ok(out.jvm.includes('-Dchemin=C:\\a b'));
  // Les arguments du launcher passent avant ceux de l'utilisateur, qui gardent le dernier mot.
  assert.ok(out.jvm.indexOf('-XX:+UseG1GC') < out.jvm.indexOf('-Dfoo=bar'));
  assert.ok(out.jvm.includes('-Djava.library.path=C:/jeu/natives'));
  assert.equal(out.jvm[out.jvm.indexOf('-cp') + 1], 'a.jar;b.jar');
  assert.ok(out.jvm.includes('-Dlog4j.configurationFile=C:/logs/client.xml'));
  assert.equal(out.jvm.at(-1), '-Dlog4j2.formatMsgNoLookups=true');
  assert.equal(out.jvm.includes('-XstartOnFirstThread'), process.platform === 'darwin');
  assert.deepEqual(out.game.slice(0, 4), ['--username', '0Rzxn_', '--version', '1.21.1']);
  assert.deepEqual(out.game.slice(4, 8), ['--width', '854', '--height', '480']);
  assert.ok(!out.game.some((arg) => arg.startsWith('--quickPlay')));
  assert.equal(out.quickPlay, null);
  assert.equal(out.librarySearchPath, path.normalize('C:/jeu/natives'));
});

test('buildArguments moderne : plein écran', () => {
  const out = buildArguments({ version: MODERN, vars: VARS, settings: { ...SETTINGS, fullscreen: true } });
  assert.ok(!out.game.includes('--width'));
  assert.equal(out.game.at(-1), '--fullscreen');
});

test('buildArguments moderne : Quick Play vers un monde puis vers un serveur', () => {
  const solo = buildArguments({ version: MODERN, vars: VARS, settings: SETTINGS, quickPlay: { type: 'singleplayer', id: 'Mon monde' }, quickPlayPath: 'quickplay.json' });
  assert.equal(solo.quickPlay, 'singleplayer');
  assert.equal(solo.game[solo.game.indexOf('--quickPlaySingleplayer') + 1], 'Mon monde');
  assert.equal(solo.game[solo.game.indexOf('--quickPlayPath') + 1], 'quickplay.json');
  assert.ok(!solo.game.includes('--quickPlayMultiplayer'));
  assert.ok(!solo.game.includes('--quickPlayRealms'));

  const multi = buildArguments({ version: MODERN, vars: VARS, settings: SETTINGS, quickPlay: { type: 'multiplayer', id: 'play.exemple.fr' } });
  assert.equal(multi.quickPlay, 'multiplayer');
  assert.equal(multi.game[multi.game.indexOf('--quickPlayMultiplayer') + 1], 'play.exemple.fr');
  assert.ok(!multi.game.includes('--quickPlayPath'));
  assert.ok(!multi.game.includes('--server'));

  // Type inconnu : ignoré.
  const realms = buildArguments({ version: MODERN, vars: VARS, settings: SETTINGS, quickPlay: { type: 'realms', id: '1' } });
  assert.equal(realms.quickPlay, null);
});

test('buildArguments ancien : minecraftArguments, résolution et classpath', () => {
  const out = buildArguments({ version: LEGACY, vars: VARS, settings: SETTINGS });
  assert.deepEqual(out.game, ['--username', '0Rzxn_', '--version', '1.21.1', '--gameDir', 'C:/jeu', '--width', '854', '--height', '480']);
  assert.ok(out.jvm.includes('-Djava.library.path=C:/jeu/natives'));
  assert.ok(out.jvm.includes('-Dminecraft.launcher.brand=0Rzxn_ Launcher'));
  assert.equal(out.jvm[out.jvm.indexOf('-cp') + 1], 'a.jar;b.jar');
  assert.equal(out.jvm.some((arg) => arg.startsWith('-XX:HeapDumpPath=')), process.platform === 'win32');
  // Java 8 par défaut : G1, jamais ZGC.
  assert.equal(out.gc, 'g1');
});

test('buildArguments ancien sous macOS : -XstartOnFirstThread, sans l’astuce de Windows', () => {
  const mac = buildArguments({ version: LEGACY, vars: VARS, settings: SETTINGS, platform: 'darwin' });
  assert.equal(mac.jvm.filter((arg) => arg === '-XstartOnFirstThread').length, 1);
  assert.equal(mac.jvm.some((arg) => arg.startsWith('-XX:HeapDumpPath=')), false);
  const windows = buildArguments({ version: LEGACY, vars: VARS, settings: SETTINGS, platform: 'win32' });
  assert.equal(windows.jvm.includes('-XstartOnFirstThread'), false);
});

test('buildArguments ancien : un serveur se rejoint avec --server/--port, pas un monde', () => {
  const multi = buildArguments({ version: LEGACY, vars: VARS, settings: SETTINGS, quickPlay: { type: 'multiplayer', id: 'play.exemple.fr:25570' } });
  assert.deepEqual(multi.game.slice(-4), ['--server', 'play.exemple.fr', '--port', '25570']);
  assert.equal(multi.quickPlay, 'multiplayer');

  const solo = buildArguments({ version: LEGACY, vars: VARS, settings: SETTINGS, quickPlay: { type: 'singleplayer', id: 'Mon monde' } });
  assert.equal(solo.quickPlay, null);
  assert.ok(!solo.game.includes('Mon monde'));
});

test('supportsQuickPlay', () => {
  assert.equal(supportsQuickPlay(MODERN), true);
  assert.equal(supportsQuickPlay(LEGACY), false);
  assert.equal(supportsQuickPlay({ arguments: { game: ['--demo'] } }), false);
});

test('serverTarget : nom, IPv4 avec port, IPv6', () => {
  assert.deepEqual(serverTarget('play.exemple.fr'), { host: 'play.exemple.fr', port: 25565 });
  assert.deepEqual(serverTarget(' 1.2.3.4:25570 '), { host: '1.2.3.4', port: 25570 });
  assert.deepEqual(serverTarget('[::1]:25566'), { host: '::1', port: 25566 });
  assert.deepEqual(serverTarget('[2001:db8::1]'), { host: '2001:db8::1', port: 25565 });
});

test('splitUserArgs : espaces et guillemets', () => {
  assert.deepEqual(splitUserArgs(''), []);
  assert.deepEqual(splitUserArgs(null), []);
  assert.deepEqual(splitUserArgs('  -Xss2M   -Da=b '), ['-Xss2M', '-Da=b']);
  // Comportement actuel : seul un argument entièrement entre guillemets garde ses espaces.
  assert.deepEqual(splitUserArgs('-Dx="un deux" "-Dy=trois quatre"'), ['-Dx="un', 'deux', '-Dy=trois quatre']);
});
