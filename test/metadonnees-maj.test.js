'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { refreshUpdateInfo, formatUpdateInfo } = require('../scripts/metadonnees-maj');

const NAME = '0Rzxn_-Launcher-Setup-1.2.3.exe';
const sha512 = (file) => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const installer = path.join(dir, NAME);
  fs.writeFileSync(installer, crypto.randomBytes(200_000));
  const info = { version: '1.2.3', url: NAME, sha512: sha512(installer), size: 200_000, releaseDate: '2026-11-12T10:00:00.000Z' };
  fs.writeFileSync(path.join(dir, 'latest.yml'), formatUpdateInfo(info));
  return { dir, installer, info };
}

test('fichier inchangé : latest.yml identique, blockmap écrit', async (t) => {
  const { dir, installer } = setup(t);
  const before = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8');
  const result = await refreshUpdateInfo(installer);
  assert.equal(result.changed, false);
  assert.equal(fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8'), before);
  assert.ok(fs.statSync(`${installer}.blockmap`).size > 0);
});

test('fichier modifié (signature) : sha512 et taille recalculés, version et date gardées', async (t) => {
  const { dir, installer, info } = setup(t);
  fs.appendFileSync(installer, Buffer.alloc(3000, 7)); // une signature ajoute des octets à la fin
  const result = await refreshUpdateInfo(installer);
  assert.equal(result.changed, true);
  const text = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8');
  assert.equal(text, formatUpdateInfo({ ...info, sha512: sha512(installer), size: 203_000 }));
});

test('refuse un latest.yml qui décrit un autre fichier', async (t) => {
  const { dir, installer, info } = setup(t);
  fs.writeFileSync(path.join(dir, 'latest.yml'), formatUpdateInfo({ ...info, url: 'autre.exe' }));
  await assert.rejects(refreshUpdateInfo(installer), /does not describe/);
});
