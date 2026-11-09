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

test('platformFor : Windows ou version neutre', () => {
  assert.equal(platformFor('win32').name, 'windows');
  assert.equal(platformFor('linux').name, 'autre');
  assert.equal(platformFor('darwin').name, 'autre');
});

test('les deux implémentations exposent les mêmes fonctions', () => {
  const windows = platformFor('win32');
  const autre = platformFor('linux');
  assert.deepEqual(shape(autre), shape(windows));
  const gpuShape = (g) => ['supported', 'listGpus', 'preference', 'setHighPerformance', 'clearPreference'].map((key) => `${key}:${typeof g[key]}`);
  assert.deepEqual(gpuShape(autre.gpu), gpuShape(windows.gpu));
  assert.equal(windows.gpu.supported, true);
  assert.equal(autre.gpu.supported, false);
});

test('version neutre : rien n’est lu ni écrit, le raccourci est refusé', async () => {
  const autre = platformFor('linux');
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
