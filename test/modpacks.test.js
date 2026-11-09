'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readPack, safeTarget, fileTasks } = require('../src/main/core/modpacks');
const { createZip } = require('../src/main/core/zip');

const GAME = path.resolve('C:/instances/pack/minecraft');

test('safeTarget : chemins dans le dossier du jeu', () => {
  assert.equal(safeTarget(GAME, 'mods/sodium.jar'), path.join(GAME, 'mods', 'sodium.jar'));
  assert.equal(safeTarget(GAME, 'config\\iris.properties'), path.join(GAME, 'config', 'iris.properties'));
  assert.equal(safeTarget(GAME, 'mods/../config/a.txt'), path.join(GAME, 'config', 'a.txt'));
});

test('safeTarget : sorties du dossier refusées', () => {
  for (const rel of ['../evil.jar', 'mods/../../evil.jar', '..\\..\\evil.dll', '/etc/passwd', 'C:/Windows/evil.dll', '', null, '.', 'mods/..']) {
    assert.throws(() => safeTarget(GAME, rel), undefined, String(rel));
  }
  // Un dossier voisin au nom qui commence pareil reste dehors.
  assert.throws(() => safeTarget(GAME, '../minecraft-evil/x.jar'));
});

test('fileTasks : sources autorisées, fichiers serveur ignorés, chemins vérifiés', () => {
  const file = (p, url, env) => ({ path: p, downloads: [url], hashes: { sha1: 'a'.repeat(40) }, fileSize: 10, env });
  const tasks = fileTasks(GAME, {
    files: [
      file('mods/sodium.jar', 'https://cdn.modrinth.com/data/AANobbMI/versions/x/sodium.jar'),
      file('mods/serveur.jar', 'https://cdn.modrinth.com/data/x/serveur.jar', { client: 'unsupported', server: 'required' }),
    ],
  });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].path, path.join(GAME, 'mods', 'sodium.jar'));
  assert.equal(tasks[0].rel, 'mods/sodium.jar');

  assert.throws(() => fileTasks(GAME, { files: [file('mods/a.jar', 'https://exemple.com/a.jar')] }));
  assert.throws(() => fileTasks(GAME, { files: [file('mods/a.jar', 'http://cdn.modrinth.com/a.jar')] }));
  assert.throws(() => fileTasks(GAME, { files: [file('../a.jar', 'https://cdn.modrinth.com/a.jar')] }));
});

const index = (overrides) => ({ formatVersion: 1, game: 'minecraft', versionId: '1.0', name: 'Pack', files: [], dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.17.2' }, ...overrides });
const pack = (data) => createZip([{ name: 'modrinth.index.json', data: Buffer.from(JSON.stringify(data)) }]);

test('readPack : lecture de l’index', () => {
  const result = readPack(pack(index()));
  assert.equal(result.mc, '1.21.1');
  assert.equal(result.loader, 'fabric');
  assert.equal(result.packLoaderVersion, '0.17.2');
  assert.equal(readPack(pack(index({ dependencies: { minecraft: '1.21.1' } }))).loader, 'vanilla');
});

test('readPack : fichiers refusés', () => {
  assert.throws(() => readPack(Buffer.from('pas un zip')));
  assert.throws(() => readPack(createZip([{ name: 'autre.json', data: Buffer.from('{}') }])));
  assert.throws(() => readPack(pack(index({ game: 'autre' }))));
  assert.throws(() => readPack(pack(index({ dependencies: { minecraft: '1.21.1', 'liteloader': '1' } }))));
});
