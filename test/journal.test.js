'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJournal, stamp } = require('../src/main/core/journal');
const { censor, GameLogParser } = require('../src/main/core/logs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '0rzxn-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FIXED = () => new Date(2026, 10, 9, 14, 3, 12, 345);
const read = (file) => fs.readFileSync(file, 'utf8');

test('stamp : date et heure locales', () => {
  assert.equal(stamp(FIXED()), '2026-11-09 14:03:12.345');
});

test('journal : niveaux, horodatage, objets et erreurs', (t) => {
  const dir = path.join(tempDir(t), 'logs');
  const journal = createJournal({ dir, now: FIXED });
  journal.debug('hidden');
  journal.info('Started', { version: '0.4.0' });
  journal.warn('Slow');
  journal.error('Failed', new Error('boom'));
  const text = read(journal.file);
  assert.equal(journal.file, path.join(dir, 'launcher.log'));
  assert.ok(!text.includes('hidden'));
  assert.ok(text.startsWith("2026-11-09 14:03:12.345 INFO  Started { version: '0.4.0' }\n"));
  assert.ok(text.includes('2026-11-09 14:03:12.345 WARN  Slow\n'));
  assert.match(text, /ERROR Failed Error: boom\n\s+at /);

  const verbose = createJournal({ dir, level: 'debug', now: FIXED });
  verbose.debug('shown');
  assert.ok(read(verbose.file).includes('DEBUG shown'));
});

test('journal : secrets déclarés et jetons masqués', (t) => {
  const journal = createJournal({ dir: tempDir(t) });
  const jwt = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;
  journal.addSecret('mon-secret-123');
  journal.addSecret('court'); // trop court pour être masqué sans risque
  journal.info('token mon-secret-123 et court');
  journal.info(`--accessToken abc.def --username Joueur ${jwt}`);
  journal.info({ access_token: 'xyz789', refresh_token: 'r3fr3sh', expires_in: 3600 });
  journal.info('https://login.exemple/?code=1&access_token=qwerty&state=2');
  const text = read(journal.file);
  for (const secret of ['mon-secret-123', 'abc.def', jwt, 'xyz789', 'r3fr3sh', 'qwerty']) assert.ok(!text.includes(secret), secret);
  assert.ok(text.includes('court'));
  assert.ok(text.includes('--username Joueur'));
  assert.ok(text.includes('expires_in: 3600'));
});

test('journal : un fichier par démarrage, les plus anciens supprimés', (t) => {
  const dir = tempDir(t);
  for (let run = 1; run <= 7; run++) createJournal({ dir, keep: 3 }).info(`run ${run}`);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['launcher-1.log', 'launcher-2.log', 'launcher.log']);
  assert.match(read(path.join(dir, 'launcher.log')), /run 7/);
  assert.match(read(path.join(dir, 'launcher-1.log')), /run 6/);
  assert.match(read(path.join(dir, 'launcher-2.log')), /run 5/);
});

test('journal : nouveau fichier quand il devient trop gros', (t) => {
  const dir = tempDir(t);
  const journal = createJournal({ dir, keep: 2, maxBytes: 200 });
  for (let i = 0; i < 10; i++) journal.info(`line ${i} ${'x'.repeat(40)}`);
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['launcher-1.log', 'launcher.log']);
  for (const file of files) assert.ok(fs.statSync(path.join(dir, file)).size <= 200);
  assert.match(read(path.join(dir, 'launcher.log')), /line 9/);
});

test('journal : dossier impossible à créer, aucune exception', (t) => {
  const blocker = path.join(tempDir(t), 'fichier');
  fs.writeFileSync(blocker, '');
  const journal = createJournal({ dir: path.join(blocker, 'logs') });
  assert.doesNotThrow(() => journal.error('nowhere'));
});

test('censor : seuls les secrets assez longs sont masqués', () => {
  assert.equal(censor('a 12345678 b 1234', ['12345678', '1234', null]), 'a •••••••• b 1234');
});

test('GameLogParser : événements XML, lignes Forge et morceaux coupés', () => {
  const lines = [];
  const parser = new GameLogParser((line) => lines.push(line), 'jeu');
  parser.push('<log4j:Event logger="a" timestamp="1762700000000" level="WARN" thread="Render thread"><log4j:Message><![CDATA[Bonjour]]></log4j:Message></log4j:Event>\n');
  parser.push('[12:00:01] [main/INFO] [minecraft/SoundEngine]: Sound engine started\n\x1b[32m[12:00:02] [main/INFO]: vert\x1b[0m\r\r\nbrut sans ');
  parser.push('format\n');
  parser.push('fin');
  parser.flush();
  assert.equal(lines[0].tag, 'Render thread/WARN');
  assert.equal(lines[0].msg, 'Bonjour');
  assert.deepEqual(lines[1], { time: '12:00:01', tag: 'main/INFO', msg: '[minecraft/SoundEngine] Sound engine started' });
  assert.deepEqual(lines[2], { time: '12:00:02', tag: 'main/INFO', msg: 'vert' });
  assert.equal(lines[3].msg, 'brut sans format');
  assert.equal(lines[3].tag, 'jeu');
  assert.equal(lines[4].msg, 'fin');
  assert.equal(lines.length, 5);
});
