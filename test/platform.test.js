'use strict';

// src/main/platform : même forme sur tous les systèmes, Windows sans jamais toucher au vrai registre.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { electron, tempRoot } = require('./helpers/faux-electron');
const { t: tr } = require('../src/main/i18n');
const { platformFor } = require('../src/main/platform');
const gpu = require('../src/main/platform/windows/gpu');

const shape = (object) =>
  Object.keys(object)
    .filter((key) => key !== 'name')
    .sort()
    .map((key) => `${key}:${typeof object[key]}`);

test('platformFor : Windows, Linux, macOS ou version neutre', () => {
  assert.equal(platformFor('win32').name, 'windows');
  assert.equal(platformFor('linux').name, 'linux');
  assert.equal(platformFor('darwin').name, 'mac');
  assert.equal(platformFor('freebsd').name, 'autre');
});

test('toutes les implémentations exposent les mêmes fonctions', () => {
  const windows = platformFor('win32');
  const gpuShape = (g) => ['supported', 'listGpus', 'preference', 'setHighPerformance', 'clearPreference'].map((key) => `${key}:${typeof g[key]}`);
  assert.equal(windows.gpu.supported, true);
  for (const name of ['linux', 'darwin', 'freebsd']) {
    const other = platformFor(name);
    assert.deepEqual(shape(other), shape(windows), name);
    assert.deepEqual(gpuShape(other.gpu), gpuShape(windows.gpu), name);
    assert.equal(other.gpu.supported, false, name);
  }
});

test('version neutre : rien n’est lu ni écrit, le raccourci est refusé', async () => {
  const autre = platformFor('freebsd');
  assert.deepEqual(await autre.gpu.listGpus(), []);
  assert.equal(await autre.gpu.preference('java'), null);
  await autre.gpu.setHighPerformance(['java']);
  await autre.gpu.clearPreference(['java']);
  assert.equal(await autre.physicalCores(), null);
  await autre.apresInstallation({});
  assert.throws(() => autre.createShortcut({ id: 'survie', name: 'Survie' }), { message: tr('ipc.les_raccourcis_bureau_sont_disponibles') });
});

test('carte graphique : cartes physiques, puce intégrée reconnue', async (t) => {
  const calls = [];
  gpu.setRunner(async (file, args) => {
    calls.push([file, ...args]);
    return JSON.stringify([
      { Name: 'NVIDIA GeForce RTX 5070', PNPDeviceID: 'PCI\\VEN_10DE&DEV_2F04' },
      { Name: 'Intel(R) UHD Graphics 770', PNPDeviceID: 'PCI\\VEN_8086&DEV_4680' },
      { Name: 'Microsoft Remote Display Adapter', PNPDeviceID: 'SWD\\RDP' },
    ]);
  });
  t.after(() => gpu.setRunner(() => Promise.reject(new Error('no runner in tests'))));
  assert.deepEqual(await gpu.listGpus(), [
    { name: 'NVIDIA GeForce RTX 5070', integrated: false },
    { name: 'Intel(R) UHD Graphics 770', integrated: true },
  ]);
  await gpu.listGpus(); // gardé en mémoire
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'powershell.exe');
  assert.equal(gpu.isIntegrated({ name: 'Intel(R) Arc(TM) A770 Graphics', pnp: 'PCI\\VEN_8086&DEV_56A0' }), false);
  assert.equal(gpu.isIntegrated({ name: 'AMD Radeon(TM) Graphics', pnp: 'PCI\\VEN_1002&DEV_164E' }), true);
  assert.equal(gpu.isIntegrated({ name: 'AMD Radeon RX 7800 XT', pnp: 'PCI\\VEN_1002&DEV_747E' }), false);
});

test('carte graphique : préférence lue, écrite, retirée seulement si « Hautes performances »', async (t) => {
  const values = new Map([['C:\\a\\java.exe', 'GpuPreference=2;'], ['C:\\b\\java.exe', 'GpuPreference=1;']]);
  const calls = [];
  gpu.setRunner(async (file, args) => {
    calls.push([file, ...args]);
    const [verb, , , exe] = args;
    if (verb === 'query') {
      if (!values.has(exe)) throw new Error('absent');
      return `\r\n${gpu.KEY}\r\n    ${exe}    REG_SZ    ${values.get(exe)}\r\n`;
    }
    if (verb === 'add') values.set(exe, args[7]);
    if (verb === 'delete') values.delete(exe);
    return '';
  });
  t.after(() => gpu.setRunner(() => Promise.reject(new Error('no runner in tests'))));
  assert.equal(await gpu.preference('C:\\a\\java.exe'), 'high');
  assert.equal(await gpu.preference('C:\\b\\java.exe'), 'saving');
  assert.equal(await gpu.preference('C:\\c\\java.exe'), null);

  await gpu.setHighPerformance(['C:\\c\\java.exe']);
  assert.deepEqual(calls.at(-1), ['reg.exe', 'add', gpu.KEY, '/v', 'C:\\c\\java.exe', '/t', 'REG_SZ', '/d', gpu.HIGH, '/f']);
  await gpu.clearPreference(['C:\\a\\java.exe', 'C:\\b\\java.exe', 'C:\\c\\java.exe']);
  assert.deepEqual([...values.keys()], ['C:\\b\\java.exe']); // « Économie d'énergie » choisie à la main : gardée
  assert.ok(calls.every(([file]) => file === 'reg.exe'));
});

test('raccourci bureau : version installée, remplacement d’un raccourci existant', (t) => {
  const root = tempRoot(t);
  electron.reset(root);
  const { createShortcut } = platformFor('win32');
  t.after(() => {
    electron.app.isPackaged = false;
  });
  electron.app.isPackaged = true;
  const instance = { id: 'survie', name: 'Survie <1>' };
  assert.equal(createShortcut(instance), 'Survie 1 (0Rzxn_).lnk');
  const [first] = electron.calls.shortcuts;
  assert.equal(first.operation, 'create');
  assert.equal(first.options.args, '--launch=survie');
  assert.equal(first.options.cwd, path.dirname(process.execPath));

  fs.writeFileSync(first.file, '');
  createShortcut(instance);
  assert.equal(electron.calls.shortcuts[1].operation, 'replace');

  // Nom fait seulement de caractères interdits : l'identifiant le remplace.
  assert.equal(createShortcut({ id: 'pvp', name: '<>' }), 'pvp (0Rzxn_).lnk');

  const refuse = electron.shell.writeShortcutLink;
  electron.shell.writeShortcutLink = () => false;
  t.after(() => {
    electron.shell.writeShortcutLink = refuse;
  });
  assert.throws(() => createShortcut(instance), { message: tr('ipc.windows_pas_pu_creer_le') });
});

test('mesures du jeu (Windows) : lignes de PowerShell lues, identifiant de processus contrôlé', async () => {
  const { parseSample, watchProcess, peakMemory, watchScript } = require('../src/main/platform/windows/process-metrics');
  assert.deepEqual(parseSample('5583457280 6576193536 123456\r'), { memory: 5583457280, peak: 6576193536, cpuMs: 123456 });
  assert.equal(parseSample('Get-Process : impossible de trouver un processus'), null);
  assert.equal(parseSample('1 2'), null);
  assert.match(watchScript('42', 2000), /Get-Process -Id 42 .*Start-Sleep -Milliseconds 2000/);

  const { EventEmitter } = require('node:events');
  const spawned = [];
  const spawnFn = (exe, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => { child.killed = true; };
    spawned.push({ exe, args, child });
    return child;
  };
  const samples = [];
  const watch = watchProcess(42, { intervalMs: 2000, onSample: (s) => samples.push(s), spawnFn });
  assert.equal(spawned[0].exe, 'powershell.exe');
  spawned[0].child.stdout.emit('data', '100 200 30');
  spawned[0].child.stdout.emit('data', '0\r\n110 210 40');
  assert.deepEqual(samples, [{ memory: 100, peak: 200, cpuMs: 300 }]);
  spawned[0].child.stdout.emit('data', '0\n');
  assert.equal(samples.length, 2);
  watch.stop();
  assert.equal(spawned[0].child.killed, true);

  // Jamais de commande avec un identifiant douteux.
  watchProcess('42; Remove-Item x', { onSample() {}, spawnFn }).stop();
  assert.equal(await peakMemory(-1, { spawnFn }), null);
  assert.equal(spawned.length, 1);

  const peak = peakMemory(42, { spawnFn });
  spawned[1].child.stdout.emit('data', '6576193536\r\n');
  spawned[1].child.emit('close');
  assert.equal(await peak, 6576193536);
});
