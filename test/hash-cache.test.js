'use strict';

// Empreintes des jars gardées dans launcher.db (core/hash-cache.js) : un jar inchangé n'est pas relu après un redémarrage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hashCache = require('../src/main/core/hash-cache');
const { listContent } = require('../src/main/core/content');
const { openDatabase } = require('../src/main/services/db');

/** Dossier temporaire et base ouverte dedans, branchée sur le cache ; la base est fermée avant d'effacer le dossier (Windows). */
function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '0rzxn-hash-'));
  const db = openDatabase({ file: path.join(dir, 'launcher.db') });
  hashCache.useStore(db);
  t.after(() => {
    hashCache.useStore(null);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('chaque lecteur garde sa partie des métadonnées, sans écraser celle de l’autre', (t) => {
  tempDb(t);
  const stat = { size: 10, mtimeMs: 1.5 };
  assert.equal(hashCache.recall('a.jar', stat, 'content'), null);
  hashCache.remember('a.jar', stat, 'sha', 'content', { name: 'A' });
  hashCache.remember('a.jar', stat, 'sha', 'check:fabric', { mainIds: ['a'] });
  assert.deepEqual(hashCache.recall('a.jar', stat, 'content'), { sha1: 'sha', value: { name: 'A' } });
  assert.deepEqual(hashCache.recall('a.jar', stat, 'check:fabric'), { sha1: 'sha', value: { mainIds: ['a'] } });
  assert.equal(hashCache.recall('a.jar', stat, 'check:forge'), null);
  assert.equal(hashCache.recall('a.jar', { size: 11, mtimeMs: 1.5 }, 'content'), null); // fichier changé
  // Contenu changé (autre empreinte) : l'ancienne partie des métadonnées est oubliée.
  hashCache.remember('a.jar', { size: 12, mtimeMs: 2 }, 'autre', 'content', { name: 'B' });
  assert.equal(hashCache.recall('a.jar', { size: 12, mtimeMs: 2 }, 'check:fabric'), null);
});

test('onglet Mods : un jar connu de launcher.db n’est pas relu', async (t) => {
  const dir = tempDb(t);
  const gameDir = path.join(dir, 'jeu');
  fs.mkdirSync(path.join(gameDir, 'mods'), { recursive: true });
  const jar = path.join(gameDir, 'mods', 'sodium.jar');
  fs.writeFileSync(jar, 'pas une vraie archive'); // relu, il donnerait le nom du fichier et une autre empreinte
  const stat = fs.statSync(jar);
  hashCache.remember(jar, stat, 'empreinte-gardee', 'content', { name: 'Sodium', version: '0.6.0', description: null, icon: null, modId: 'sodium' });
  const { items } = await listContent({ gameDir, kind: 'mods', instance: { version: '1.21.1', loader: 'fabric' }, online: false });
  assert.deepEqual(items.map((i) => [i.file, i.name, i.version, i.sha1, i.modId]), [['sodium.jar', 'Sodium', '0.6.0', 'empreinte-gardee', 'sodium']]);
});
