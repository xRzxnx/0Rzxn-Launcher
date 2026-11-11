'use strict';

// launcher.db : création, migrations avec copie, base abîmée ou plus récente, historique des tâches et des parties.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase, MIGRATIONS } = require('../src/main/services/db');

function dbFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '0rzxn-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'launcher.db');
}

/** Lecture directe du fichier, par une autre connexion. */
function peek(file, sql) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}
const userVersion = (file) => peek(file, 'PRAGMA user_version')[0].user_version;
const tables = (file) => peek(file, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);

test('base neuve : schéma v1, mode WAL, pas de copie', (t) => {
  const file = dbFile(t);
  const db = openDatabase({ file });
  assert.equal(db.available, true);
  assert.equal(db.version, MIGRATIONS.length);
  assert.equal(db.problem, null);
  db.close();
  db.close(); // deux fois : sans effet
  assert.equal(userVersion(file), 1);
  assert.deepEqual(tables(file), ['game_sessions', 'tasks']);
  assert.equal(peek(file, 'PRAGMA journal_mode')[0].journal_mode, 'wal');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.avant-')), []);
});

test('migration : copie de la base avant, données gardées, deux copies au plus', (t) => {
  const file = dbFile(t);
  const first = openDatabase({ file });
  first.recordTask({ id: 't1', kind: 'backup', state: 'done', createdAt: Date.now() });
  first.close();

  const v2 = [...MIGRATIONS, 'CREATE TABLE extra2 (a TEXT)'];
  const second = openDatabase({ file, migrations: v2 });
  assert.equal(second.version, 2);
  assert.equal(second.recentTasks().length, 1);
  second.close();
  const copy = `${file}.avant-v2`;
  assert.ok(fs.existsSync(copy));
  assert.equal(userVersion(copy), 1);
  assert.equal(peek(copy, 'SELECT id FROM tasks')[0].id, 't1');

  for (const n of [3, 4]) {
    const migrations = [...v2, ...Array.from({ length: n - 2 }, (_, i) => `CREATE TABLE extra${i + 3} (a TEXT)`)];
    openDatabase({ file, migrations }).close();
  }
  const copies = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.avant-v')).sort();
  assert.deepEqual(copies, ['launcher.db.avant-v3', 'launcher.db.avant-v4']);
  assert.equal(userVersion(file), 4);
});

test('migration en échec : rien n’est changé, le launcher continue sans base', (t) => {
  const file = dbFile(t);
  const first = openDatabase({ file });
  first.recordTask({ id: 't1', kind: 'backup', state: 'done' });
  first.close();
  const broken = openDatabase({ file, migrations: [...MIGRATIONS, 'CREATE TABLE ok (a); CREATE TABLE tasks (a)'] });
  assert.equal(broken.available, false);
  assert.equal(broken.problem, 'error');
  assert.equal(broken.recordTask({ id: 't2', kind: 'x', state: 'done' }), null);
  assert.deepEqual(broken.recentTasks(), []);
  broken.close();
  assert.equal(userVersion(file), 1);
  assert.deepEqual(tables(file), ['game_sessions', 'tasks']);
  assert.equal(peek(file, 'SELECT count(*) AS n FROM tasks')[0].n, 1);
});

test('base illisible : mise de côté, une base neuve la remplace', (t) => {
  const file = dbFile(t);
  const garbage = 'pas une base SQLite '.repeat(300);
  fs.writeFileSync(file, garbage);
  const db = openDatabase({ file, now: () => new Date(2026, 10, 9, 21, 5, 7).getTime() });
  assert.equal(db.available, true);
  assert.equal(db.version, 1);
  db.close();
  const aside = `${file}.abimee-2026-11-09_21-05-07`;
  assert.equal(fs.readFileSync(aside, 'utf8'), garbage);
  assert.equal(userVersion(file), 1);
});

test('base d’une version plus récente du launcher : laissée telle quelle', (t) => {
  const file = dbFile(t);
  openDatabase({ file, migrations: [...MIGRATIONS, 'CREATE TABLE future (a)'] }).close();
  const before = fs.readFileSync(file);
  const db = openDatabase({ file });
  assert.equal(db.available, false);
  assert.equal(db.problem, 'newer');
  assert.equal(db.startSession({ instanceId: 'survie' }), null);
  db.close();
  assert.equal(userVersion(file), 2);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('dossier impossible à créer : pas de base, aucune erreur', (t) => {
  const file = dbFile(t);
  fs.writeFileSync(path.join(path.dirname(file), 'fichier'), '');
  const db = openDatabase({ file: path.join(path.dirname(file), 'fichier', 'launcher.db') });
  assert.equal(db.available, false);
  assert.equal(db.problem, 'error');
  assert.equal(db.endSession(1, { outcome: 'exited' }), null);
  assert.deepEqual(db.recentSessions('survie'), []);
});

test('tâches : enregistrées, mises à jour, de la plus récente à la plus ancienne', (t) => {
  const file = dbFile(t);
  const db = openDatabase({ file });
  db.recordTask({ id: 'a', kind: 'modpack-install', label: 'Installation de X', state: 'running', createdAt: 1000, startedAt: 1001, params: { projectId: 'p1' } });
  db.recordTask({ id: 'b', kind: 'world-backup', instanceId: 'survie', state: 'cancelled', createdAt: 2000, endedAt: 2500 });
  db.recordTask({ id: 'a', kind: 'modpack-install', label: 'Installation de X', state: 'failed', createdAt: 1000, startedAt: 1001, endedAt: 3000, error: 'Réseau', params: { projectId: 'p1' } });
  const list = db.recentTasks();
  assert.deepEqual(list.map((r) => [r.id, r.state]), [['b', 'cancelled'], ['a', 'failed']]);
  assert.deepEqual(list[1].params, { projectId: 'p1' });
  assert.equal(list[1].error, 'Réseau');
  assert.equal(list[0].instance_id, 'survie');
  db.close();
});

test('ménage : tâches de plus de 90 jours retirées, 1 000 gardées au plus', (t) => {
  const file = dbFile(t);
  const now = Date.now();
  const db = openDatabase({ file });
  db.recordTask({ id: 'vieille', kind: 'x', state: 'done', createdAt: now - 100 * 86400000, endedAt: now - 100 * 86400000 });
  db.recordTask({ id: 'en-cours', kind: 'x', state: 'running', createdAt: now - 100 * 86400000 });
  for (let i = 0; i < 1005; i++) db.recordTask({ id: `t${i}`, kind: 'x', state: 'done', createdAt: now - 1000 + i, endedAt: now });
  db.close();
  const again = openDatabase({ file });
  const ids = new Set(again.recentTasks(2000).map((r) => r.id));
  again.close();
  assert.equal(ids.size, 1000);
  assert.ok(!ids.has('vieille'));
  assert.ok(ids.has('t1004') && !ids.has('t0'));
});

test('sessions de jeu : début, jeu prêt, fin', (t) => {
  const file = dbFile(t);
  const db = openDatabase({ file });
  const id = db.startSession({ instanceId: 'survie', version: '1.21.1', loader: 'fabric', startedAt: 10_000 });
  assert.equal(typeof id, 'number');
  db.sessionReady(id, 14_500);
  db.endSession(id, { outcome: 'crashed', exitCode: 1, endedAt: 70_000 });
  const other = db.startSession({ instanceId: 'survie', startedAt: 80_000 });
  db.endSession(other, { outcome: 'cancelled', endedAt: 81_000 });
  db.startSession({ instanceId: 'creatif', startedAt: 90_000 });
  assert.equal(db.sessionReady(null), null);

  const sessions = db.recentSessions('survie');
  assert.deepEqual(
    sessions.map((s) => ({ ...s })),
    [
      { id: other, instance_id: 'survie', version: null, loader: null, started_at: 80_000, ready_at: null, ended_at: 81_000, outcome: 'cancelled', exit_code: null, prepare_ms: null },
      { id, instance_id: 'survie', version: '1.21.1', loader: 'fabric', started_at: 10_000, ready_at: 14_500, ended_at: 70_000, outcome: 'crashed', exit_code: 1, prepare_ms: 4500 },
    ],
  );
  db.close();
});

test('tâches : progression finale et travail de fond rangés dans params sans changer le format, historique effaçable', (t) => {
  const file = dbFile(t);
  const db = openDatabase({ file });
  db.recordTask({ id: 'a', kind: 'modpack-install', state: 'done', createdAt: 1, params: { title: 'X' }, progress: { done: 25, total: 25, totalBytes: 1500 } });
  db.recordTask({ id: 'b', kind: 'temp-cleanup', state: 'done', createdAt: 2, hidden: true, progress: {} });
  db.recordTask({ id: 'c', kind: 'x', state: 'running', createdAt: 3 });
  const [c, b, a] = db.recentTasks();
  assert.deepEqual([a.params, a.progress, a.hidden], [{ title: 'X' }, { done: 25, total: 25, totalBytes: 1500 }, false]);
  assert.deepEqual([b.params, b.progress, b.hidden], [null, null, true]);
  assert.deepEqual([c.params, c.progress, c.hidden], [null, null, false]);
  db.clearTasks();
  assert.deepEqual(db.recentTasks().map((r) => r.id), ['c']); // une tâche pas finie n'est pas effacée
  db.close();
});
