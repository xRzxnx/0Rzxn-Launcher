'use strict';

// Contrat entre l'interface et le processus principal : écrit sur l'ipc.js d'origine, il doit rester vrai
// sans modification après le découpage en src/main/ipc/ et src/main/services/ (phase 3).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { journal } = require('../src/main/core/journal');
const { t: tr } = require('../src/main/i18n');
const { startIpc, electron } = require('./helpers/ipc');

const MAIN = path.join(__dirname, '..', 'src', 'main');
const preload = fs.readFileSync(path.join(MAIN, 'preload.js'), 'utf8');
const names = (text, pattern) => [...text.matchAll(pattern)].map((m) => m[1]);

/** Tous les fichiers du processus principal, sauf preload.js (côté interface). */
function mainSources(dir = MAIN) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'i18n' || entry.name === 'assets' ? [] : mainSources(full);
    return entry.name.endsWith('.js') && entry.name !== 'preload.js' ? [full] : [];
  });
}

test('contrat : les canaux enregistrés sont exactement ceux exposés par preload.js', (t) => {
  startIpc(t);
  const exposed = names(preload, /invoke\('([\w:]+)'\)/g).sort();
  const registered = [...electron.calls.handlers.keys()].sort();
  assert.equal(new Set(exposed).size, exposed.length, 'canal exposé deux fois dans preload.js');
  assert.deepEqual(registered, exposed);
  // 103 + tasks:list (gestionnaire de tâches, phase 3) + tasks:history, tasks:cancel, tasks:clearHistory (page Activité, phase 5)
  assert.equal(registered.length, 107);
});

test('contrat : protocoles fond: et skin:', (t) => {
  startIpc(t);
  assert.deepEqual([...electron.calls.protocols.keys()].sort(), ['fond', 'skin']);
});

test('contrat : les événements envoyés sont ceux écoutés par preload.js', () => {
  const listened = names(preload, /listen\('([\w:]+)'\)/g).sort();
  const sent = new Set(mainSources().flatMap((file) => names(fs.readFileSync(file, 'utf8'), /\bsend\(\s*'([\w:]+)'/g)));
  assert.deepEqual([...sent].sort(), listened);
  // « tasks:changed » ajouté par le gestionnaire de tâches (phase 3), pour la page Activité.
  assert.deepEqual(listened, ['app:launchRequest', 'launch:logs', 'launch:progress', 'launch:reset', 'launch:status', 'task:progress', 'tasks:changed', 'update:status']);
});

test('contrat : le fichier de types suit preload.js (canaux et événements)', () => {
  const file = path.join(MAIN, 'ipc', 'types.d.ts');
  const types = fs.readFileSync(file, 'utf8');
  const union = types.slice(types.indexOf('export type InvokeChannel'), types.indexOf(';', types.indexOf('export type InvokeChannel')));
  assert.deepEqual(names(union, /'([\w:]+)'/g).sort(), names(preload, /invoke\('([\w:]+)'\)/g).sort());
  const events = types.slice(types.indexOf('export interface Events'));
  assert.deepEqual(names(events, /'([\w:]+)':/g).sort(), names(preload, /listen\('([\w:]+)'\)/g).sort());
});

test('origine : un message venu d’une autre page est refusé', async (t) => {
  const ipc = startIpc(t);
  await assert.rejects(ipc.invokeAs({}, 'app:info'), { message: tr('ipc.origine_refusee') });
  assert.equal((await ipc.invoke('app:info')).version, '0.4.0');
});

test('erreurs : notées au journal puis renvoyées telles quelles (synchrones et asynchrones)', async (t) => {
  const ipc = startIpc(t);
  const warn = t.mock.method(journal, 'warn', () => {});
  // Erreur levée tout de suite par le canal.
  const sync = await ipc.invoke('instances:duplicate', 'inconnue', 'Copie').catch((error) => error);
  assert.ok(sync instanceof Error);
  assert.equal(sync.message, tr('instances.instance_introuvable'));
  // Erreur d'une promesse.
  const late = await ipc.invoke('instances:update', 'inconnue', { name: 'X' }).catch((error) => error);
  assert.ok(late instanceof Error);
  assert.deepEqual(
    warn.mock.calls.map((c) => c.arguments),
    [
      ['IPC instances:duplicate failed:', sync],
      ['IPC instances:update failed:', late],
    ],
  );
});

test('app:info et system:memory', async (t) => {
  const ipc = startIpc(t);
  const info = await ipc.invoke('app:info');
  assert.deepEqual(Object.keys(info).sort(), ['discordReady', 'microsoftReady', 'platform', 'root', 'version']);
  assert.equal(info.platform, process.platform);
  assert.ok(fs.existsSync(path.join(info.root, 'instances')));
  const memory = await ipc.invoke('system:memory');
  assert.ok(memory.totalGb > 0 && memory.freeGb > 0);
});

test('bilan du mois : seule une vraie image PNG est enregistrée', async (t) => {
  const ipc = startIpc(t);
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(800, 16);
  png.writeUInt32BE(600, 20);

  await assert.rejects(ipc.invoke('stats:saveRecapImage', '2026-13', new Uint8Array(png)), { message: tr('ipc.mois_invalide') });
  await assert.rejects(ipc.invoke('stats:saveRecapImage', '2026-11', new Uint8Array(10)), { message: tr('ipc.image_refusee_taille_inattendue') });
  await assert.rejects(ipc.invoke('stats:saveRecapImage', '2026-11', new Uint8Array(40)), { message: tr('ipc.image_refusee_ce_est_pas') });
  const huge = Buffer.from(png);
  huge.writeUInt32BE(5000, 16);
  await assert.rejects(ipc.invoke('stats:saveRecapImage', '2026-11', new Uint8Array(huge)), { message: tr('ipc.image_refusee_ce_est_pas') });

  assert.equal(await ipc.invoke('stats:saveRecapImage', '2026-11', new Uint8Array(png)), null); // dialogue annulé
  const target = path.join(ipc.root, 'bilan.png');
  electron.dialog.next = { canceled: false, filePath: target };
  assert.equal(await ipc.invoke('stats:saveRecapImage', '2026-11', new Uint8Array(png)), target);
  assert.deepEqual(fs.readFileSync(target), png);
});
