'use strict';

// Gestionnaire de tâches : états, file, priorités, limites, annulation, événements, historique,
// et compatibilité avec l'ancien runTask (une tâche longue à la fois, « Patiente… », task:progress).
const test = require('node:test');
const assert = require('node:assert/strict');
const { t: tr } = require('../src/main/i18n');
const { TaskManager } = require('../src/main/services/tasks');

/** Travail contrôlé depuis le test. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(options = {}) {
  const sent = [];
  const records = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload === undefined ? undefined : structuredClone(payload)]) } };
  const manager = new TaskManager({ getWindow: () => win, history: { recordTask: (task) => records.push(task) }, ...options });
  const messages = (channel) => sent.filter(([c]) => c === channel).map(([, p]) => p);
  return { manager, sent, records, messages };
}

/** Lance une tâche dont la fin est décidée par le test. */
function controlled(manager, options = {}) {
  const gate = deferred();
  const calls = { started: 0, signal: null, progress: null };
  const promise = manager.run({
    kind: 'test',
    label: options.label ?? 'Tâche',
    ...options,
    work: ({ signal, progress }) => {
      calls.started += 1;
      calls.signal = signal;
      calls.progress = progress;
      return gate.promise;
    },
  });
  promise.catch(() => {}); // les tests vérifient les rejets eux-mêmes
  return { promise, gate, calls };
}

const states = (manager) => manager.list().map((task) => `${task.label}:${task.state}`);
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('tâche terminée : résultat rendu, historique écrit, plus rien en cours', async () => {
  const { manager, records, messages } = setup();
  const a = controlled(manager, { label: 'A', kind: 'modpack-install', instanceId: 'survie', params: { projectId: 'p' } });
  assert.deepEqual(states(manager), ['A:running']);
  assert.equal(manager.busy(), true);
  assert.equal(manager.current(), 'A');
  a.gate.resolve(42);
  assert.equal(await a.promise, 42);
  assert.equal(manager.busy(), false);
  assert.equal(manager.current(), null);
  assert.equal(records.length, 1);
  assert.deepEqual({ ...records[0], id: 'x', createdAt: 0, startedAt: 0, endedAt: 0 }, {
    id: 'x', kind: 'modpack-install', label: 'A', instanceId: 'survie', state: 'done', createdAt: 0, startedAt: 0, endedAt: 0, error: null, params: { projectId: 'p' },
  });
  assert.deepEqual(messages('tasks:changed').at(-1), []);
});

test('tâche en échec : même erreur rendue, notée dans l’historique', async () => {
  const { manager, records } = setup();
  const boom = new Error('Réseau injoignable');
  const a = controlled(manager);
  a.gate.reject(boom);
  await assert.rejects(a.promise, (error) => error === boom);
  assert.equal(records[0].state, 'failed');
  assert.equal(records[0].error, 'Réseau injoignable');
  // Erreur levée tout de suite par le travail.
  await assert.rejects(manager.run({ kind: 'x', label: 'B', work: () => { throw boom; } }), (error) => error === boom);
  assert.equal(records[1].state, 'failed');
});

test('file : deux tâches à la fois au plus, la suivante démarre quand une finit', async () => {
  const { manager } = setup();
  const a = controlled(manager, { label: 'A' });
  const b = controlled(manager, { label: 'B' });
  const c = controlled(manager, { label: 'C' });
  assert.deepEqual(states(manager), ['A:running', 'B:running', 'C:queued']);
  assert.equal(c.calls.started, 0);
  b.gate.resolve();
  await b.promise;
  assert.deepEqual(states(manager), ['A:running', 'C:running']);
  a.gate.resolve();
  c.gate.resolve();
  await Promise.all([a.promise, c.promise]);
});

test('priorités : haute, puis normale, puis basse, chacune dans l’ordre d’arrivée', async () => {
  const { manager } = setup({ limit: 1 });
  const order = [];
  const first = controlled(manager, { label: 'A' });
  const add = (label, priority) => manager.run({ kind: 'x', label, priority, work: async () => order.push(label) });
  const all = [add('B', 'normal'), add('C', 'low'), add('D', 'high'), add('E', 'normal'), add('F', 'high')];
  assert.deepEqual(states(manager), ['A:running', 'D:queued', 'F:queued', 'B:queued', 'E:queued', 'C:queued']);
  first.gate.resolve();
  await Promise.all(all);
  assert.deepEqual(order, ['D', 'F', 'B', 'E', 'C']);
});

test('une seule tâche à la fois par instance', async () => {
  const { manager } = setup();
  const a = controlled(manager, { label: 'A', instanceId: 'survie' });
  const b = controlled(manager, { label: 'B', instanceId: 'survie' });
  const c = controlled(manager, { label: 'C', instanceId: 'creatif' });
  assert.deepEqual(states(manager), ['A:running', 'C:running', 'B:queued']);
  a.gate.resolve();
  await a.promise;
  assert.deepEqual(states(manager), ['B:running', 'C:running']);
  b.gate.resolve();
  c.gate.resolve();
  await Promise.all([b.promise, c.promise]);
});

test('annulation d’une tâche en attente : retirée sans avoir commencé', async () => {
  const { manager, records } = setup({ limit: 1 });
  const a = controlled(manager, { label: 'A' });
  const b = controlled(manager, { label: 'B' });
  const [, queued] = manager.list();
  assert.equal(manager.cancel(queued.id), true);
  await assert.rejects(b.promise, { message: tr('ipc.tache_annulee_avant_debut', { task: 'B' }) });
  assert.equal(b.calls.started, 0);
  assert.equal(records.at(-1).state, 'cancelled');
  assert.equal(records.at(-1).startedAt, null);
  a.gate.resolve();
  await a.promise;
  assert.equal(b.calls.started, 0);
  assert.equal(manager.cancel('inconnue'), false);
});

test('annulation d’une tâche en cours : seulement si elle l’accepte', async () => {
  const { manager, records } = setup();
  const locked = controlled(manager, { label: 'A' });
  assert.equal(manager.cancel(manager.list()[0].id), false);
  assert.equal(locked.calls.signal.aborted, false);

  const open = controlled(manager, { label: 'B', cancellable: true });
  assert.equal(manager.cancel(manager.list()[1].id), true);
  assert.equal(open.calls.signal.aborted, true);
  const stop = new Error('Sauvegarde annulée');
  open.gate.reject(stop);
  await assert.rejects(open.promise, (error) => error === stop);
  assert.equal(records.at(-1).state, 'cancelled');

  // Annulée trop tard : la tâche a fini quand même, elle compte comme terminée.
  const late = controlled(manager, { label: 'C', cancellable: true });
  manager.cancel(manager.list().find((task) => task.label === 'C').id);
  late.gate.resolve('fini');
  assert.equal(await late.promise, 'fini');
  assert.equal(records.at(-1).state, 'done');
  locked.gate.resolve();
  await locked.promise;
});

test('compatibilité : une tâche longue à la fois, refus « Patiente… »', async () => {
  const { manager } = setup();
  let release;
  const first = manager.runLong('Installation de X', () => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(manager.runLong('Sauvegarde de Monde', async () => {}), { message: tr('ipc.patiente_est_en_cours', { task: 'Installation de X' }) });
  // Une tâche hors du groupe « long » n'est pas bloquée.
  assert.equal(await manager.run({ kind: 'x', label: 'Autre', work: async () => 'ok' }), 'ok');
  release('fait');
  assert.equal(await first, 'fait');
  assert.equal(await manager.runLong('Suivante', async () => 'ok'), 'ok');
});

test('compatibilité : task:progress comme avant (début, étapes, null à la fin)', async () => {
  const { manager, messages } = setup();
  let step;
  let gotSignal;
  const done = deferred();
  const running = manager.runLong('Sauvegarde des mondes', (onProgress, signal) => {
    step = onProgress;
    gotSignal = signal;
    return done.promise;
  }, { cancellable: true });
  step({ label: 'Sauvegarde de Monde', done: 1, total: 4 });
  step({ done: 4, total: 4 });
  done.resolve();
  await running;
  assert.ok(gotSignal instanceof AbortSignal);
  assert.deepEqual(messages('task:progress'), [
    { label: 'Sauvegarde des mondes', done: 0, total: 0, cancellable: true },
    { label: 'Sauvegarde de Monde', done: 1, total: 4, cancellable: true },
    { label: 'Sauvegarde des mondes', done: 4, total: 4, cancellable: true },
    null,
  ]);

  // Sans annulation possible : pas de signal, et cancel() sans identifiant ne fait rien.
  let noSignal = 'non appelé';
  const other = manager.runLong('Pack performances', (_progress, signal) => {
    noSignal = signal;
    return new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(manager.cancel(), false);
  await other;
  assert.equal(noSignal, undefined);
});

test('tasks:changed : tout de suite pour un état, au plus toutes les 100 ms pour la progression', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { manager, messages } = setup();
  const a = controlled(manager, { label: 'A' });
  const afterStart = messages('tasks:changed').length;
  assert.ok(afterStart >= 1);
  assert.equal(messages('tasks:changed').at(-1)[0].state, 'running');
  for (let i = 1; i <= 20; i++) a.calls.progress({ done: i, total: 20 });
  assert.equal(messages('tasks:changed').length, afterStart);
  t.mock.timers.tick(100);
  assert.equal(messages('tasks:changed').length, afterStart + 1);
  assert.deepEqual(messages('tasks:changed').at(-1)[0].progress, { label: 'A', done: 20, total: 20 });
  a.gate.resolve();
  await a.promise;
  await flush();
  assert.deepEqual(messages('tasks:changed').at(-1), []);
});

test('sans fenêtre ni base : tout fonctionne', async () => {
  const manager = new TaskManager();
  assert.equal(await manager.run({ kind: 'x', label: 'A', work: async () => 1 }), 1);
  assert.equal(await manager.runLong('B', async () => 2), 2);
});
