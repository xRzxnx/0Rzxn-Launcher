'use strict';

// Dossiers par système (platform/chemins.js), Java du PC et cœurs physiques sous Linux et macOS, simulés sous n'importe quel système.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gameRoot, importRoots, javaSearchDirs } = require('../src/main/platform/chemins');
const { systemJavaCandidates, javaFolderName } = require('../src/main/core/java');
const { coresFromCpuinfo, linuxPhysicalCores, macPhysicalCores } = require('../src/main/platform/cpu');
const { defaultInstancesDir } = require('../src/main/core/importer');

const win = { platform: 'win32', home: 'C:\\Users\\Ana', appData: 'C:\\Users\\Ana\\AppData\\Roaming', env: {} };
const mac = { platform: 'darwin', home: '/Users/ana', appData: '/Users/ana/Library/Application Support', env: {} };
const linux = { platform: 'linux', home: '/home/ana', appData: '/home/ana/.config', env: {} };

test('dossier du jeu : %APPDATA% sous Windows et macOS, règle XDG sous Linux', () => {
  assert.equal(gameRoot(win), 'C:\\Users\\Ana\\AppData\\Roaming\\.0rzxn');
  assert.equal(gameRoot(mac), '/Users/ana/Library/Application Support/.0rzxn');
  assert.equal(gameRoot(linux), '/home/ana/.local/share/0rzxn');
  assert.equal(gameRoot({ ...linux, env: { XDG_DATA_HOME: '/data/ana' } }), '/data/ana/0rzxn');
  // Valeur relative : ignorée, comme le veut la règle XDG.
  assert.equal(gameRoot({ ...linux, env: { XDG_DATA_HOME: 'data' } }), '/home/ana/.local/share/0rzxn');
});

test('import : dossiers de données du launcher compatible, Flatpak compris sous Linux', () => {
  assert.deepEqual(importRoots(win), ['C:\\Users\\Ana\\AppData\\Roaming\\PrismLauncher']);
  assert.deepEqual(importRoots(mac), ['/Users/ana/Library/Application Support/PrismLauncher']);
  assert.deepEqual(importRoots(linux), [
    '/home/ana/.local/share/PrismLauncher',
    '/home/ana/.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher',
  ]);
});

test('import : le premier dossier qui existe est pris, avec son réglage InstanceDir', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '0rzxn-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const absent = path.join(root, 'absent');
  const flatpak = path.join(root, 'flatpak');
  assert.equal(defaultInstancesDir([absent, flatpak]), path.join(absent, 'instances'));
  fs.mkdirSync(flatpak);
  fs.writeFileSync(path.join(flatpak, 'prismlauncher.cfg'), '[General]\nInstanceDir=mes-instances\n');
  assert.equal(defaultInstancesDir([absent, flatpak]), path.join(flatpak, 'mes-instances'));
});

/** Faux dossiers : { '/usr/lib/jvm': ['java-21-openjdk'] } → readdir qui ne renvoie que des dossiers. */
const fakeReaddir = (tree) => (dir) => {
  if (!tree[dir]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return tree[dir].map((name) => ({ name, isDirectory: () => true }));
};

test('Java du PC sous Linux : /usr/lib/jvm, SDKMAN, JetBrains, JAVA_HOME puis PATH', () => {
  const readdir = fakeReaddir({
    '/usr/lib/jvm': ['java-21-openjdk-amd64'],
    '/home/ana/.sdkman/candidates/java': ['17.0.12-tem'],
    '/home/ana/.jdks': ['corretto-8'],
  });
  const env = { JAVA_HOME: '/opt/jdk-25', PATH: '/usr/local/bin:/usr/bin' };
  assert.deepEqual(systemJavaCandidates({ platform: 'linux', home: '/home/ana', env, readdir }), [
    '/usr/lib/jvm/java-21-openjdk-amd64/bin/java',
    '/home/ana/.sdkman/candidates/java/17.0.12-tem/bin/java',
    '/home/ana/.jdks/corretto-8/bin/java',
    '/opt/jdk-25/bin/java',
    '/usr/local/bin/java',
    '/usr/bin/java',
  ]);
});

test('Java du PC sous macOS : JavaVirtualMachines et Homebrew (seulement openjdk*)', () => {
  const readdir = fakeReaddir({
    '/Library/Java/JavaVirtualMachines': ['temurin-21.jdk'],
    '/Users/ana/Library/Java/JavaVirtualMachines': ['zulu-17.jdk'],
    '/opt/homebrew/opt': ['openjdk@21', 'python@3.13'],
  });
  const found = systemJavaCandidates({ platform: 'darwin', home: '/Users/ana', env: {}, readdir });
  assert.deepEqual(found, [
    '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java',
    '/Users/ana/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home/bin/java',
    '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java',
  ]);
  assert.deepEqual(found.map(javaFolderName), ['temurin-21', 'zulu-17', 'openjdk@21']);
});

test('Java du PC sous Windows : dossiers des éditeurs, inchangés', () => {
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramW6432: 'C:\\Program Files', Path: 'C:\\Windows;C:\\jdk\\bin' };
  const readdir = fakeReaddir({ 'C:\\Program Files\\Eclipse Adoptium': ['jdk-21.0.5.11-hotspot'] });
  assert.deepEqual(systemJavaCandidates({ platform: 'win32', home: 'C:\\Users\\Ana', env, readdir }), [
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.5.11-hotspot\\bin\\java.exe',
    'C:\\Windows\\java.exe',
    'C:\\jdk\\bin\\java.exe',
  ]);
  // Program Files ne compte qu'une fois même s'il apparaît deux fois.
  const parents = javaSearchDirs({ ...win, env }).map((d) => d.parent);
  assert.equal(parents.filter((p) => p === 'C:\\Program Files\\Java').length, 1);
  assert.equal(javaFolderName('C:\\Program Files\\Common Files\\Oracle\\Java\\javapath\\java.exe'), 'javapath');
  assert.equal(javaFolderName('C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\java.exe'), 'jdk-21');
});

test('cœurs physiques sous Linux : couples (processeur, cœur) uniques de /proc/cpuinfo', async () => {
  // 2 cœurs à 2 fils chacun : 4 blocs, 2 cœurs.
  const block = (n, core) => `processor\t: ${n}\nphysical id\t: 0\ncore id\t\t: ${core}\n`;
  const cpuinfo = [block(0, 0), block(1, 1), block(2, 0), block(3, 1)].join('\n');
  assert.equal(coresFromCpuinfo(cpuinfo), 2);
  assert.equal(coresFromCpuinfo('processor\t: 0\nmodel name\t: ARM\n'), null);
  assert.equal(await linuxPhysicalCores({ read: () => cpuinfo }), 2);
  assert.equal(await linuxPhysicalCores({ read: () => { throw new Error('EACCES'); } }), null);
});

test('cœurs physiques sous macOS : sysctl hw.physicalcpu', async () => {
  const calls = [];
  const run = (file, args, options, done) => {
    calls.push([file, ...args]);
    done(null, '10\n');
  };
  assert.equal(await macPhysicalCores({ run }), 10);
  assert.deepEqual(calls, [['/usr/sbin/sysctl', '-n', 'hw.physicalcpu']]);
  assert.equal(await macPhysicalCores({ run: (f, a, o, done) => done(new Error('absent'), '') }), null);
});
