'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zip = require('../src/main/core/zip');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '0rzxn-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const TEXT = Buffer.from('bonjour '.repeat(500));
const RANDOM = crypto.randomBytes(2048); // incompressible : rangé sans compression

test('createZip puis lecture en mémoire', () => {
  const buffer = zip.createZip([
    { name: 'texte.txt', data: TEXT },
    { name: 'dossier/aléatoire.bin', data: RANDOM },
    { name: 'vide.txt', data: Buffer.alloc(0) },
  ]);
  const entries = zip.listEntries(buffer);
  assert.deepEqual(entries.map((e) => e.name), ['texte.txt', 'dossier/aléatoire.bin', 'vide.txt']);
  assert.equal(entries[0].method, 8);
  assert.equal(entries[1].method, 0);
  assert.ok(entries[0].compressedSize < TEXT.length);
  assert.deepEqual(zip.readFile(buffer, 'texte.txt'), TEXT);
  assert.deepEqual(zip.readFile(buffer, 'dossier/aléatoire.bin', entries), RANDOM);
  assert.equal(zip.readFile(buffer, 'vide.txt').length, 0);
  assert.equal(zip.readFile(buffer, 'absent.txt'), null);
});

test('listEntries : archive invalide', () => {
  assert.throws(() => zip.listEntries(Buffer.from('ceci n’est pas une archive zip, vraiment pas')));
});

test('readEntry : méthode de compression inconnue', () => {
  const buffer = zip.createZip([{ name: 'a.txt', data: TEXT }]);
  const [entry] = zip.listEntries(buffer);
  assert.throws(() => zip.readEntry(buffer, { ...entry, method: 14 }));
});

test('writeZipFile puis openZipFile sur le disque', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'level.dat'), TEXT);
  fs.writeFileSync(path.join(dir, 'r.0.0.mca'), RANDOM);
  const target = path.join(dir, 'sauvegarde.zip');
  const progress = [];
  const result = await zip.writeZipFile(
    target,
    [
      { name: 'Monde/level.dat', path: path.join(dir, 'level.dat') },
      { name: 'Monde/region/r.0.0.mca', path: path.join(dir, 'r.0.0.mca'), store: true },
    ],
    { onProgress: (p) => progress.push(p) },
  );
  assert.equal(result.files, 2);
  assert.equal(fs.existsSync(`${target}.part`), false);
  assert.deepEqual(progress[0], { done: 0, total: 2 });
  assert.deepEqual(progress.at(-1), { done: 2, total: 2 });

  const archive = await zip.openZipFile(target);
  try {
    assert.deepEqual(archive.entries.map((e) => e.name), ['Monde/level.dat', 'Monde/region/r.0.0.mca']);
    assert.equal(archive.entries[1].method, 0);
    assert.deepEqual(await archive.read(archive.entries[0]), TEXT);
    assert.deepEqual(await archive.read(archive.entries[1]), RANDOM);
  } finally {
    await archive.close();
  }
  // L'archive sur disque se lit aussi en mémoire.
  assert.deepEqual(zip.readFile(fs.readFileSync(target), 'Monde/level.dat'), TEXT);
});

test('writeZipFile : annulation, aucun fichier laissé', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), TEXT);
  const target = path.join(dir, 'annulee.zip');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(zip.writeZipFile(target, [{ name: 'a.txt', path: path.join(dir, 'a.txt') }], { signal: controller.signal }));
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(`${target}.part`), false);
});

test('openZipFile : fichier qui n’est pas une archive', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'faux.zip');
  fs.writeFileSync(file, 'rien à voir');
  await assert.rejects(zip.openZipFile(file));
});
