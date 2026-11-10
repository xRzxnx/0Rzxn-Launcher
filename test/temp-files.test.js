'use strict';

// core/temp-files.js : seuls les fichiers temporaires abandonnés des dossiers de téléchargement partent, jamais les mondes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanTemporaryFiles } = require('../src/main/core/temp-files');

const NOW = Date.now();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

test('nettoyage : .part de plus de 7 jours, anciens .tmp de plus d’une heure, sauvegardes inachevées d’un jour', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '0rzxn-tmp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = Object.fromEntries(['versions', 'libraries', 'assets', 'runtime', 'cache', 'instances', 'backups'].map((name) => [name, path.join(root, name)]));
  const files = {
    'versions/1.21.11/1.21.11.jar.part': 8 * DAY, // parti
    'libraries/org/a/a.jar.part': 2 * DAY, // gardé : reprise encore possible
    'assets/objects/ab/abcdef.4242.1.tmp': 2 * HOUR, // parti
    'runtime/java/bin/java.dll.4242.2.tmp': 10 * 60 * 1000, // gardé : peut-être en cours
    'cache/modpacks/pack.mrpack.part': 30 * DAY, // parti
    'instances/survie/minecraft/mods/sodium.jar.part': 9 * DAY, // parti
    'instances/survie/minecraft/saves/Monde/region.part': 90 * DAY, // gardé : jamais dans les mondes
    'instances/survie/minecraft/mods/sous/x.jar.part': 90 * DAY, // gardé : seulement le premier niveau des dossiers de contenu
    'backups/survie/Monde_2026.zip.part': 2 * DAY, // parti
    'backups/survie/Monde_2026-2.zip.part': 2 * HOUR, // gardé : sauvegarde peut-être en cours
    'libraries/org/a/a.jar': 400 * DAY, // gardé : vrai fichier
    'versions/notes.tmp': 400 * DAY, // gardé : pas un fichier du launcher
  };
  for (const [rel, age] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(10));
    const when = new Date(NOW - age);
    fs.utimesSync(file, when, when);
  }
  const result = await cleanTemporaryFiles({ dirs, now: NOW });
  const left = Object.keys(files).filter((rel) => fs.existsSync(path.join(root, rel)));
  assert.deepEqual(left.sort(), [
    'backups/survie/Monde_2026-2.zip.part',
    'instances/survie/minecraft/mods/sous/x.jar.part',
    'instances/survie/minecraft/saves/Monde/region.part',
    'libraries/org/a/a.jar',
    'libraries/org/a/a.jar.part',
    'runtime/java/bin/java.dll.4242.2.tmp',
    'versions/notes.tmp',
  ]);
  assert.deepEqual(result, { count: 5, bytes: 50 });
});

test('nettoyage : dossiers absents, rien à faire', async () => {
  const missing = path.join(os.tmpdir(), '0rzxn-absent-' + Date.now());
  const dirs = Object.fromEntries(['versions', 'libraries', 'assets', 'runtime', 'cache', 'instances', 'backups'].map((name) => [name, path.join(missing, name)]));
  assert.deepEqual(await cleanTemporaryFiles({ dirs }), { count: 0, bytes: 0 });
});
