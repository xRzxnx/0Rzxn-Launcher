'use strict';

// Comportement des canaux qui orchestrent plusieurs modules (réglages, instances, mondes, tâches, lancement).
// Écrit sur l'ipc.js d'origine : doit rester vrai sans modification après le découpage en services (phase 3).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { t: tr } = require('../src/main/i18n');
const { startIpc, sessions, makeWorld, waitFor, wire, electron, gameMetrics } = require('./helpers/ipc');

// downloads ajouté en phase 4 (limites de téléchargement).
const LAUNCHER_DEFAULTS = { language: 'auto', accent: 'violet', discord: false, discordShowName: true, tray: true, closeToTray: false, lightMode: true, gpuHighPerformance: false, autoUpdate: true, updateChannel: 'stable', downloads: { concurrency: 16, perHost: 8 } };

async function newInstance(ipc, name = 'Survie', extra = {}) {
  const instance = await ipc.invoke('instances:create', { name, version: '1.21.1', loader: 'vanilla', ...extra });
  const { root } = await ipc.invoke('app:info');
  return { instance, gameDir: path.join(root, 'instances', instance.id, 'minecraft'), backupDir: path.join(root, 'backups', instance.id), root };
}

const zips = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.zip')) : []);

// ---------- Réglages ----------

test('réglages du launcher : valeurs par défaut, filtrage et enregistrement', async (t) => {
  const ipc = startIpc(t);
  assert.deepEqual(await ipc.invoke('launcher:get'), LAUNCHER_DEFAULTS);
  const saved = await ipc.invoke('launcher:set', { accent: '#AABBCC', discord: 'oui', tray: false, language: 'de', inconnu: 1 });
  assert.deepEqual(saved, { ...LAUNCHER_DEFAULTS, accent: '#aabbcc', tray: false });
  assert.deepEqual(await ipc.invoke('launcher:set', { accent: 'bleu', closeToTray: true }), { ...saved, accent: 'bleu', closeToTray: true });
  assert.deepEqual(await ipc.invoke('launcher:set', { accent: 'orange' }), { ...saved, accent: 'bleu', closeToTray: true });
  const file = JSON.parse(fs.readFileSync(path.join(ipc.root, 'config', 'settings.json'), 'utf8'));
  assert.equal(file.launcher.accent, 'bleu');
  assert.deepEqual(await ipc.invoke('launcher:set', null), file.launcher);
  assert.equal((await ipc.invoke('launcher:set', { updateChannel: 'nightly' })).updateChannel, 'stable');
  assert.equal((await ipc.invoke('launcher:set', { updateChannel: 'beta' })).updateChannel, 'beta');
});

test('langue : changée sans redémarrer, les messages suivent', async (t) => {
  const ipc = startIpc(t);
  assert.deepEqual(ipc.hooks.language(), { lang: 'fr', locale: 'fr-FR' });
  t.after(() => ipc.invoke('launcher:setLanguage', 'auto'));
  assert.deepEqual(await ipc.invoke('launcher:setLanguage', 'es'), { lang: 'es', locale: 'es-ES' });
  assert.deepEqual(ipc.hooks.language(), { lang: 'es', locale: 'es-ES' });
  await assert.rejects(ipc.invokeAs({}, 'app:info'), { message: tr('ipc.origine_refusee') });
  assert.equal((await ipc.invoke('launcher:get')).language, 'es');
  assert.deepEqual(await ipc.invoke('launcher:setLanguage', 'auto'), { lang: 'fr', locale: 'fr-FR' });
});

test('préférences d’interface : ui:get et ui:set filtrent ce qu’ils gardent', async (t) => {
  const ipc = startIpc(t);
  assert.deepEqual(await ipc.invoke('ui:get'), { selectedId: null, pendingLaunch: null, reopenView: null });
  const groups = [...Array.from({ length: 120 }, (_, i) => `g${i}`), 42, null];
  const ui = await ipc.invoke('ui:set', { selectedId: 'survie', collapsedGroups: groups, crashesSeenAt: 1234, autre: true });
  assert.deepEqual(ui, { selectedId: 'survie', collapsedGroups: groups.slice(0, 100), crashesSeenAt: 1234 });
  assert.deepEqual(await ipc.invoke('ui:set', { selectedId: 12, crashesSeenAt: Infinity }), ui);
  assert.deepEqual(await ipc.invoke('ui:set', { selectedId: null }), { ...ui, selectedId: null });
  assert.deepEqual(await ipc.invoke('ui:set', null), { ...ui, selectedId: null });
});

test('réglages par défaut des instances : lus, modifiés, utilisés à la création', async (t) => {
  const ipc = startIpc(t);
  const defaults = await ipc.invoke('settings:get');
  assert.equal(defaults.ram, 4);
  const changed = await ipc.invoke('settings:update', { ram: 6 });
  assert.equal(changed.ram, 6);
  assert.deepEqual(await ipc.invoke('settings:get'), changed);
  const { instance } = await newInstance(ipc);
  assert.equal(instance.settings.ram, 6);
});

// ---------- Instances ----------

test('instances : création, liste, duplication, suppression dans la corbeille', async (t) => {
  const ipc = startIpc(t);
  const { instance } = await newInstance(ipc);
  assert.equal(instance.id, 'survie');
  const copy = await ipc.invoke('instances:duplicate', 'survie', 'Survie 2');
  assert.deepEqual((await ipc.invoke('instances:list')).map((i) => i.id).sort(), ['survie', copy.id].sort());

  await ipc.invoke('ui:set', { selectedId: 'survie' });
  await ipc.invoke('instances:delete', 'survie');
  assert.equal(electron.calls.trashed.length, 1);
  assert.equal(path.basename(electron.calls.trashed[0]), 'survie');
  assert.equal((await ipc.invoke('ui:get')).selectedId, null);
  assert.deepEqual((await ipc.invoke('instances:list')).map((i) => i.id), [copy.id]);
});

test('raccourci bureau : nom nettoyé, arguments du lancement direct', { skip: process.platform !== 'win32' }, async (t) => {
  const ipc = startIpc(t);
  await newInstance(ipc, 'Survie: "Nuit"');
  const id = (await ipc.invoke('instances:list'))[0].id;
  const name = await ipc.invoke('instances:shortcut', id);
  assert.equal(name, 'Survie Nuit (0Rzxn_).lnk');
  const [link] = electron.calls.shortcuts;
  assert.equal(link.file, path.join(electron.app.getPath('desktop'), name));
  assert.equal(link.operation, 'create');
  assert.equal(link.options.target, process.execPath);
  assert.equal(link.options.args, `"${electron.app.getAppPath()}" --launch=${id}`);
  assert.equal(link.options.description, tr('ipc.lancer_avec_0rzxn_launcher', { name: 'Survie: "Nuit"' }));
});

test('protocole fond: : seulement les images « fond-… » du dossier de l’instance', async (t) => {
  const ipc = startIpc(t);
  const { gameDir } = await newInstance(ipc);
  const image = Buffer.from('image');
  fs.writeFileSync(path.join(gameDir, '..', 'fond-1.png'), image);
  fs.writeFileSync(path.join(gameDir, '..', 'instance.png'), image);
  const fond = electron.calls.protocols.get('fond');
  const ok = await fond({ url: 'fond://survie/fond-1.png' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), image);
  for (const url of ['fond://survie/instance.png', 'fond://survie/fond-2.png', 'fond://inconnue/fond-1.png', 'fond://SURVIE!/fond-1.png']) {
    assert.equal((await fond({ url })).status, 404, url);
  }
});

// ---------- Mondes et tâche longue ----------

test('sauvegarde d’un monde : la seconde attend son tour (même instance), progression puis fin', async (t) => {
  const ipc = startIpc(t);
  const { instance, gameDir, backupDir } = await newInstance(ipc);
  makeWorld(gameDir, 'Monde');
  const label = tr('ipc.sauvegarde_de', { name: 'Monde' });

  const running = ipc.invoke('worlds:backup', instance.id, 'Monde');
  const queued = ipc.invoke('worlds:backup', instance.id, 'Monde');
  assert.deepEqual((await ipc.invoke('tasks:list')).map((task) => task.state), ['running', 'queued']);
  // Libérer de l'espace reste refusé pendant une tâche.
  await assert.rejects(ipc.invoke('storage:clean', []), { message: tr('ipc.patiente_est_en_cours', { task: label }) });
  await Promise.all([running, queued]);

  const progress = ipc.win.messages('task:progress');
  assert.deepEqual(progress[0], { label, done: 0, total: 0, cancellable: true });
  assert.equal(progress.at(-1), null);
  assert.equal(zips(backupDir).length, 2);
});

test('tasks:cancel retire une tâche en attente par son identifiant ; tasks:history et tasks:clearHistory', async (t) => {
  const ipc = startIpc(t);
  const { instance, gameDir } = await newInstance(ipc);
  makeWorld(gameDir, 'Monde');
  const running = ipc.invoke('worlds:backup', instance.id, 'Monde');
  const queued = ipc.invoke('worlds:backup', instance.id, 'Monde');
  queued.catch(() => {});
  const [, waiting] = await ipc.invoke('tasks:list');
  assert.equal(await ipc.invoke('tasks:cancel'), false); // sans identifiant : rien
  assert.equal(await ipc.invoke('tasks:cancel', 'inconnue'), false);
  assert.equal(await ipc.invoke('tasks:cancel', waiting.id), true);
  await assert.rejects(queued, { message: tr('ipc.tache_annulee_avant_debut', { task: tr('ipc.sauvegarde_de', { name: 'Monde' }) }) });
  await running;

  const history = await ipc.invoke('tasks:history');
  // Créées dans la même milliseconde parfois : comparées sans l'ordre.
  assert.deepEqual(history.map((task) => [task.kind, task.state, task.instanceId, task.params]).sort((a, b) => a[1].localeCompare(b[1])), [
    ['world-backup', 'cancelled', instance.id, { folder: 'Monde', name: 'Survie' }],
    ['world-backup', 'done', instance.id, { folder: 'Monde', name: 'Survie' }],
  ]);
  const done = history.find((task) => task.state === 'done');
  assert.ok(done.progress.total > 0 && done.progress.done === done.progress.total);
  await ipc.invoke('tasks:clearHistory');
  assert.deepEqual(await ipc.invoke('tasks:history'), []);
});

test('sauvegarde d’un monde : task:cancel l’arrête', async (t) => {
  const ipc = startIpc(t);
  const { instance, gameDir, backupDir } = await newInstance(ipc);
  makeWorld(gameDir, 'Monde');
  const running = ipc.invoke('worlds:backup', instance.id, 'Monde');
  await ipc.invoke('task:cancel');
  await assert.rejects(running, { message: tr('zip.sauvegarde_annulee') });
  assert.equal(ipc.win.messages('task:progress').at(-1), null);
  assert.equal(zips(backupDir).length, 0);
  await ipc.invoke('task:cancel'); // sans tâche : rien à faire
});

test('changement de version : les mondes sont sauvegardés avant, sauf demande contraire', async (t) => {
  const ipc = startIpc(t);
  const { instance, gameDir, backupDir } = await newInstance(ipc);

  // Sans monde : pas de tâche.
  assert.equal((await ipc.invoke('instances:update', instance.id, { version: '1.21.2' })).version, '1.21.2');
  assert.equal(ipc.win.messages('task:progress').length, 0);

  makeWorld(gameDir, 'Monde');
  assert.equal((await ipc.invoke('instances:update', instance.id, { version: '1.21.4' })).version, '1.21.4');
  const progress = ipc.win.messages('task:progress');
  assert.deepEqual(progress[0], { label: tr('ipc.sauvegarde_des_mondes'), done: 0, total: 0, cancellable: true });
  const labels = new Set(progress.slice(1, -1).map((p) => p.label));
  assert.deepEqual([...labels].sort(), [tr('ipc.sauvegarde_de', { name: 'Monde' }), tr('ipc.sauvegarde_des_mondes')].sort());
  assert.equal(progress.at(-1), null);
  assert.equal(zips(backupDir).length, 1);

  // Le nom seul ne déclenche rien ; « skipBackup » non plus.
  await ipc.invoke('instances:update', instance.id, { name: 'Survie bis' });
  await ipc.invoke('instances:update', instance.id, { version: '1.21.5' }, { skipBackup: true });
  assert.equal(zips(backupDir).length, 1);
  assert.equal((await ipc.invoke('instances:list'))[0].version, '1.21.5');
});

test('changement de version : sauvegarde automatique désactivée dans l’instance', async (t) => {
  const ipc = startIpc(t);
  const { instance, gameDir, backupDir } = await newInstance(ipc);
  await ipc.invoke('instances:update', instance.id, { settings: { ...instance.settings, backupAuto: false } });
  makeWorld(gameDir, 'Monde');
  await ipc.invoke('instances:update', instance.id, { version: '1.21.4' });
  assert.equal(zips(backupDir).length, 0);
});

// ---------- Lancement ----------

test('lancement : adresse de serveur ou monde invalides refusés avant tout lancement', async (t) => {
  const ipc = startIpc(t, { account: true });
  const { instance } = await newInstance(ipc);
  const start = (quickPlay) => ipc.invoke('launch:start', instance.id, { skipBackup: true, quickPlay });
  await assert.rejects(start({ type: 'multiplayer', id: 'mauvaise adresse !' }), { message: tr('ipc.adresse_de_serveur_invalide') });
  await assert.rejects(start({ type: 'singleplayer', id: 'Absent' }));
  assert.equal(sessions.length, 0);

  await start({ type: 'multiplayer', id: 'play.example.org:25565', name: 'Serveur' });
  assert.deepEqual(sessions[0].quickPlay, { type: 'multiplayer', id: 'play.example.org:25565', name: 'Serveur' });
});

test('lancement : sans compte, refusé', async (t) => {
  const ipc = startIpc(t);
  const { instance } = await newInstance(ipc);
  await assert.rejects(ipc.invoke('launch:start', instance.id, { skipBackup: true }), { message: tr('common.ajoute_un_compte_avant_de') });
  assert.equal(sessions.length, 0);
});

test('lancement : état, logs envoyés par paquets, partie unique, échec', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ipc = startIpc(t, { account: true });
  const { instance } = await newInstance(ipc);
  const run = await ipc.invoke('launch:start', instance.id, { skipBackup: true });
  assert.deepEqual(run, { instanceId: instance.id, phase: 'preparing', step: 0, done: 0, total: 0, prepareOnly: false });
  assert.deepEqual(ipc.win.sent.filter(([channel]) => channel.startsWith('launch:')).slice(-2), [['launch:reset', undefined], ['launch:status', { run }]]);
  const [session] = sessions;
  assert.equal(session.verify, false);
  // La préparation est aussi une tâche (page Activité), hors de la file.
  const [prepare] = await ipc.invoke('tasks:list');
  assert.deepEqual([prepare.kind, prepare.state, prepare.instanceId, prepare.immediate, prepare.cancellable, prepare.params], ['launch-prepare', 'running', instance.id, true, true, { name: 'Survie', prepareOnly: false }]);

  // Une seule partie à la fois, et rien ne touche l'instance pendant ce temps.
  await assert.rejects(ipc.invoke('launch:start', instance.id), { message: tr('ipc.une_partie_ou_une_installation') });
  await assert.rejects(ipc.invoke('launch:start', instance.id, { skipBackup: true }), { message: tr('ipc.une_partie_ou_une_installation') });
  await assert.rejects(ipc.invoke('instances:duplicate', instance.id, 'Copie'), { message: tr('ipc.impossible_de_pendant_que_instance', { action: tr('ipc.action_duplicate') }) });
  await assert.rejects(ipc.invoke('storage:clean', []), { message: tr('ipc.impossible_de_pendant_une_partie', { action: tr('ipc.liberer_de_espace') }) });
  await assert.rejects(ipc.invoke('instances:update', instance.id, { version: '1.21.4' }), { message: tr('ipc.impossible_de_changer_de_version') });

  // Logs : regroupés toutes les 100 ms.
  const line = (n) => ({ time: '12:00:00', tag: 'LAUNCHER', msg: `ligne ${n}` });
  for (const n of [1, 2, 3]) session.emit('log', line(n));
  assert.equal(ipc.win.messages('launch:logs').length, 0);
  t.mock.timers.tick(99);
  assert.equal(ipc.win.messages('launch:logs').length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(ipc.win.messages('launch:logs'), [[line(1), line(2), line(3)]]);

  session.emit('progress', { step: 2, done: 10, total: 40 });
  assert.deepEqual(ipc.win.messages('launch:progress').at(-1), { ...run, step: 2, done: 10, total: 40 });
  assert.deepEqual((await ipc.invoke('tasks:list'))[0].progress, { label: prepare.label, done: 10, total: 40, step: 2 });
  assert.deepEqual(wire(await ipc.invoke('launch:state')), { run: { ...run, step: 2, done: 10, total: 40 }, logs: [line(1), line(2), line(3)] });

  // Échec : les derniers logs partent avant le changement d'état.
  session.emit('log', line(4));
  session.emit('failed', { message: 'boom' });
  const [logs, failed] = ipc.win.sent.slice(-2);
  assert.deepEqual(logs, ['launch:logs', [line(4)]]);
  assert.deepEqual(wire(failed), ['launch:status', { run: null, error: 'boom', instanceId: instance.id }]);
  assert.equal((await ipc.invoke('launch:state')).run, null);
  assert.deepEqual(await ipc.invoke('tasks:list'), []);

  // Annulation depuis la page Activité : la préparation s'arrête, pas de message d'erreur.
  await ipc.invoke('launch:start', instance.id, { skipBackup: true });
  const [second] = await ipc.invoke('tasks:list');
  assert.equal(await ipc.invoke('tasks:cancel', second.id), true);
  assert.equal(sessions[1].stopped, true);
  sessions[1].emit('failed', { message: 'annulé', cancelled: true });
  assert.deepEqual(wire(ipc.win.messages('launch:status').at(-1)), { run: null, error: null, cancelled: true, instanceId: instance.id });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await ipc.invoke('tasks:history')).slice(0, 2).map((task) => [task.kind, task.state, task.error]), [
    ['launch-prepare', 'cancelled', 'annulé'],
    ['launch-prepare', 'failed', 'boom'],
  ]);
});

test('lancement : trop de logs d’un coup, l’interface reçoit tout le tampon', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ipc = startIpc(t, { account: true });
  const { instance } = await newInstance(ipc);
  await ipc.invoke('launch:start', instance.id, { skipBackup: true });
  const [session] = sessions;
  for (let n = 1; n <= 5001; n++) session.emit('log', { time: '12:00:00', tag: 'LAUNCHER', msg: `ligne ${n}` });
  const before = ipc.win.sent.length;
  t.mock.timers.tick(100);
  const after = ipc.win.sent.slice(before);
  assert.deepEqual(after.map(([channel]) => channel), ['launch:reset', 'launch:logs']);
  const lines = after[1][1];
  assert.equal(lines.length, 5000);
  assert.equal(lines[0].msg, 'ligne 2');
  assert.equal(lines.at(-1).msg, 'ligne 5001');
  assert.equal((await ipc.invoke('launch:state')).logs.length, 5000);
});

test('lancement : partie en cours, mode léger, fin de partie', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ipc = startIpc(t, { account: true });
  const { instance } = await newInstance(ipc);
  await ipc.invoke('launch:start', instance.id, { skipBackup: true });
  const [session] = sessions;

  session.emit('running');
  const status = ipc.win.messages('launch:status').at(-1);
  assert.equal(status.run.phase, 'running');
  assert.equal(typeof status.run.startedAt, 'number');
  assert.equal(ipc.win.minimized, true); // réglage « après le lancement : réduire » par défaut

  // Fenêtre réduite : les logs attendent son retour.
  const line = { time: '12:00:01', tag: 'Render thread/INFO', msg: 'Loaded' };
  session.emit('log', line);
  session.emit('log', line);
  t.mock.timers.tick(500);
  assert.equal(ipc.win.messages('launch:logs').length, 0);
  ipc.win.restore();
  ipc.hooks.windowShown();
  t.mock.timers.tick(0);
  assert.deepEqual(ipc.win.messages('launch:logs'), [[line, line]]);

  // Fin de partie : temps de jeu noté, fenêtre réaffichée, état final.
  ipc.win.minimize();
  session.emit('exit', { code: 0, crashed: false, minutes: 3 });
  await waitFor(() => ipc.win.messages('launch:status').at(-1).run === null);
  assert.deepEqual(wire(ipc.win.messages('launch:status').at(-1)), { run: null, exited: true, code: 0, crashed: false, crash: null, instanceId: instance.id });
  assert.equal(ipc.win.minimized, false);
  assert.equal((await ipc.invoke('instances:list'))[0].playtime, 3);
});

test('lancement : plantage, les logs sont gardés comme rapport', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ipc = startIpc(t, { account: true });
  const { instance } = await newInstance(ipc);
  await ipc.invoke('launch:start', instance.id, { skipBackup: true });
  const [session] = sessions;
  session.emit('running');
  session.emit('log', { time: '12:00:02', tag: 'Render thread/ERROR', msg: 'Boom' });
  session.emit('exit', { code: 1, crashed: true, minutes: 0 });
  await waitFor(() => ipc.win.messages('launch:status').at(-1).exited);
  const status = ipc.win.messages('launch:status').at(-1);
  assert.equal(status.crashed, true);
  assert.equal(status.code, 1);
  assert.equal(status.crash.source, 'log');
  assert.equal(typeof status.crash.file, 'string');
});

test('lancement : chaque partie est notée dans launcher.db', async (t) => {
  const ipc = startIpc(t, { account: true });
  const { instance } = await newInstance(ipc);
  await ipc.invoke('launch:start', instance.id, { skipBackup: true });
  sessions[0].emit('running');
  sessions[0].emit('exit', { code: 0, crashed: false, minutes: 1 });
  await waitFor(() => ipc.win.messages('launch:status').at(-1).exited);
  await ipc.invoke('launch:start', instance.id, { skipBackup: true });
  sessions[1].emit('failed', { message: 'annulé', cancelled: true });
  await ipc.invoke('launch:start', instance.id, { skipBackup: true, prepareOnly: true });
  sessions[2].emit('prepared');

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(ipc.root, 'config', 'launcher.db'), { readOnly: true });
  const rows = db.prepare('SELECT * FROM game_sessions ORDER BY id').all();
  db.close();
  assert.deepEqual(rows.map((r) => [r.instance_id, r.version, r.loader, r.outcome, r.exit_code]), [
    [instance.id, '1.21.1', 'vanilla', 'exited', 0],
    [instance.id, '1.21.1', 'vanilla', 'cancelled', null],
    [instance.id, '1.21.1', 'vanilla', 'prepared', null],
  ]);
  assert.ok(rows[0].ready_at >= rows[0].started_at && rows[0].ended_at >= rows[0].ready_at);
  assert.equal(rows[0].prepare_ms, rows[0].ready_at - rows[0].started_at);
  assert.equal(rows[1].ready_at, null);
});

test('tâches : chaque tâche finie est notée dans launcher.db', async (t) => {
  const ipc = startIpc(t);
  const { instance, gameDir } = await newInstance(ipc);
  makeWorld(gameDir, 'Monde');
  await ipc.invoke('worlds:backup', instance.id, 'Monde');
  const cancelled = ipc.invoke('worlds:backup', instance.id, 'Monde');
  await ipc.invoke('task:cancel');
  await assert.rejects(cancelled);

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(ipc.root, 'config', 'launcher.db'), { readOnly: true });
  const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at, id').all();
  db.close();
  assert.deepEqual(rows.map((r) => [r.kind, r.state, r.instance_id, r.label, JSON.parse(r.params).folder]), [
    ['world-backup', 'done', instance.id, tr('ipc.sauvegarde_de', { name: 'Monde' }), 'Monde'],
    ['world-backup', 'cancelled', instance.id, tr('ipc.sauvegarde_de', { name: 'Monde' }), 'Monde'],
  ]);
  assert.equal(rows[1].error, tr('zip.sauvegarde_annulee'));
});

test('tasks:list : la tâche en cours, puis plus rien', async (t) => {
  const ipc = startIpc(t);
  const { instance, gameDir } = await newInstance(ipc);
  makeWorld(gameDir, 'Monde');
  assert.deepEqual(await ipc.invoke('tasks:list'), []);
  const running = ipc.invoke('worlds:backup', instance.id, 'Monde');
  const [task] = await ipc.invoke('tasks:list');
  assert.deepEqual([task.kind, task.state, task.instanceId, task.cancellable, task.label], ['world-backup', 'running', instance.id, true, tr('ipc.sauvegarde_de', { name: 'Monde' })]);
  await running;
  assert.deepEqual(await ipc.invoke('tasks:list'), []);
  const changed = ipc.win.messages('tasks:changed');
  assert.equal(changed.at(-1).length, 0);
  assert.ok(changed.some((list) => list[0]?.state === 'running'));
});

test('lancement : octets, vitesse et temps restant transmis pendant un téléchargement, retirés ensuite', async (t) => {
  const ipc = startIpc(t, { account: true });
  const { instance } = await newInstance(ipc);
  await ipc.invoke('launch:start', instance.id, { skipBackup: true });
  const [session] = sessions;
  session.progress(2, 10, 40, { doneBytes: 1000, totalBytes: 4000, speed: 500, eta: 6, done: 10 });
  assert.deepEqual(wire(ipc.win.messages('launch:progress').at(-1)), { instanceId: instance.id, phase: 'preparing', step: 2, done: 10, total: 40, prepareOnly: false, doneBytes: 1000, totalBytes: 4000, speed: 500, eta: 6 });
  session.progress(3);
  assert.deepEqual(wire(ipc.win.messages('launch:progress').at(-1)), { instanceId: instance.id, phase: 'preparing', step: 3, done: 0, total: 0, prepareOnly: false });
  await ipc.invoke('launch:stop');
  session.emit('failed', { message: 'annulé', cancelled: true });
});

test('limites de téléchargement : bornées, enregistrées et appliquées tout de suite', async (t) => {
  const net = require('../src/main/core/net');
  t.after(() => net.configure({ concurrency: 16, perHost: 8 }));
  const ipc = startIpc(t);
  assert.deepEqual(net.limits(), { concurrency: 16, perHost: 8 });
  const prefs = await ipc.invoke('launcher:set', { downloads: { concurrency: 200, perHost: 0 } });
  assert.deepEqual(prefs.downloads, { concurrency: 64, perHost: 1 });
  assert.deepEqual(net.limits(), { concurrency: 64, perHost: 1 });
  assert.deepEqual((await ipc.invoke('launcher:set', { downloads: { concurrency: 'beaucoup', perHost: 4 } })).downloads, { concurrency: 64, perHost: 4 });
  assert.deepEqual((await ipc.invoke('launcher:set', { accent: 'bleu' })).downloads, { concurrency: 64, perHost: 4 });
  assert.deepEqual(net.limits(), { concurrency: 64, perHost: 4 });
});

// ---------- Phase 6 : interface fermée pendant la partie ----------

test('« Masquer » ferme l’interface pendant la partie ; l’icône la rouvre ; la fin de partie la rouvre et lui est remise', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ipc = startIpc(t, { account: true });
  const { instance } = await newInstance(ipc);
  await ipc.invoke('instances:update', instance.id, { settings: { ...instance.settings, afterLaunch: 'hide' } });
  await ipc.invoke('ui:set', { view: 'console' }); // en mémoire seulement
  assert.equal((await ipc.invoke('ui:get')).view, undefined); // pas dans les réglages enregistrés

  await ipc.invoke('launch:start', instance.id, { skipBackup: true });
  const [session] = sessions;
  session.emit('running', { pid: 1234 });
  assert.equal(ipc.win, null);
  assert.equal(ipc.hooks.keepsRunning(), true);

  // Logs pendant que la fenêtre est fermée : gardés dans le moteur.
  const line = (n) => ({ time: '12:00:00', tag: 'LAUNCHER', msg: `ligne ${n}` });
  session.emit('log', line(1));
  t.mock.timers.tick(200);

  // Clic sur l'icône : nouvelle fenêtre, sur l'écran noté, avec tous les logs par launch:state.
  const [tray] = electron.calls.trays;
  tray.click();
  assert.equal(ipc.windows.length, 2);
  assert.equal(ipc.hooks.keepsRunning(), false);
  assert.equal((await ipc.invoke('ui:get')).reopenView, 'console');
  assert.equal((await ipc.invoke('ui:get')).reopenView, null);
  assert.deepEqual((await ipc.invoke('launch:state')).logs, [line(1)]);
  t.mock.timers.tick(200);
  assert.equal(ipc.win.messages('launch:logs').length, 0); // pas de doublon

  // Fin de partie avec la fenêtre rouverte : rien de gardé pour plus tard.
  session.emit('exit', { code: 0, crashed: false, minutes: 3 });
  await new Promise((resolve) => setImmediate(resolve));
  const state = await ipc.invoke('launch:state');
  assert.equal(state.ended, undefined); // fenêtre ouverte : la fin est partie par launch:status
  assert.deepEqual(wire(ipc.win.messages('launch:status').at(-1)), { run: null, exited: true, code: 0, crashed: false, crash: null, instanceId: instance.id });
});

test('fin de partie pendant que l’interface est fermée : fenêtre recréée, fin remise une fois par launch:state', async (t) => {
  const ipc = startIpc(t, { account: true });
  const { instance } = await newInstance(ipc);
  await ipc.invoke('instances:update', instance.id, { settings: { ...instance.settings, afterLaunch: 'hide' } });
  await ipc.invoke('launch:start', instance.id, { skipBackup: true });
  const [session] = sessions;
  session.emit('running', { pid: 1234 });
  assert.equal(ipc.win, null);
  session.emit('exit', { code: 0, crashed: false, minutes: 3 });
  await waitFor(() => ipc.win && ipc.windows.length === 2);
  await waitFor(() => !ipc.hooks.keepsRunning());
  const first = await ipc.invoke('launch:state');
  assert.deepEqual(wire(first.ended), { exited: true, code: 0, crashed: false, crash: null, instanceId: instance.id });
  assert.equal((await ipc.invoke('launch:state')).ended, undefined);
});

test('« Masquer » sans icône près de l’horloge ou sans mode léger : la fenêtre reste (réduite ou cachée)', async (t) => {
  const ipc = startIpc(t, { account: true });
  const { instance } = await newInstance(ipc);
  await ipc.invoke('instances:update', instance.id, { settings: { ...instance.settings, afterLaunch: 'hide' } });
  await ipc.invoke('launcher:set', { tray: false });
  await ipc.invoke('launch:start', instance.id, { skipBackup: true });
  sessions[0].emit('running', { pid: 1 });
  assert.equal(ipc.win.minimized, true);
  assert.equal(ipc.hooks.keepsRunning(), false);
  sessions[0].emit('exit', { code: 0, crashed: false, minutes: 0 });
  await waitFor(() => ipc.win.messages('launch:status').at(-1)?.exited);

  await ipc.invoke('launcher:set', { tray: true, lightMode: false });
  await ipc.invoke('launch:start', instance.id, { skipBackup: true });
  sessions[1].emit('running', { pid: 2 });
  assert.equal(ipc.win.visible, false);
  assert.equal(ipc.windows.length, 1);
});

// ---------- Phase 6 : mesures du jeu et temps de lancement ----------

test('mesures du jeu : mémoire et processeur fenêtre ouverte, pic et menu notés avec la partie', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const ipc = startIpc(t, { account: true });
  const { instance } = await newInstance(ipc);
  // Fenêtre gardée ouverte : une fenêtre réduite (mode léger) ne reçoit pas les mesures.
  await ipc.invoke('instances:update', instance.id, { settings: { ...instance.settings, afterLaunch: 'keep' } });
  await ipc.invoke('launch:start', instance.id, { skipBackup: true });
  const [session] = sessions;
  t.mock.timers.tick(1500); // préparation
  session.emit('running', { pid: 4242 });
  const [watch] = gameMetrics.watches;
  assert.equal(watch.pid, 4242);

  const GB = 1024 ** 3;
  watch.onSample({ memory: 2 * GB, peak: 2 * GB, cpuMs: 1000 });
  t.mock.timers.tick(2000);
  const cpus = require('node:os').cpus().length;
  watch.onSample({ memory: 3 * GB, peak: 3.5 * GB, cpuMs: 1000 + 2000 * cpus * 0.25 }); // un quart du PC pendant 2 s
  const metrics = ipc.win.messages('launch:metrics');
  assert.equal(metrics.length, 2);
  assert.deepEqual(metrics[1], { instanceId: instance.id, memory: 3 * GB, peak: 3.5 * GB, cpu: 25, allocated: instance.settings.ram * GB });
  assert.deepEqual((await ipc.invoke('launch:state')).metrics, metrics[1]);

  // Menu du jeu : ligne repérée 9,8 s après le démarrage de Java, ligne du launcher ajoutée à la console.
  t.mock.timers.tick(7800);
  session.emit('log', { time: '21:13:12', tag: 'Render thread/INFO', msg: 'Sound engine started' });
  const logs = (await ipc.invoke('launch:state')).logs;
  assert.equal(logs.at(-1).mark, true);
  assert.equal(logs.at(-1).msg, tr('launch.menu_atteint', { game: (9.8).toLocaleString('fr', { minimumFractionDigits: 1 }), total: (11.3).toLocaleString('fr', { minimumFractionDigits: 1 }) }));
  session.emit('log', { time: '21:13:20', tag: 'Render thread/INFO', msg: 'Sound engine started' }); // une seule fois
  assert.equal((await ipc.invoke('launch:state')).logs.filter((l) => l.mark).length, 1);

  // Fin de partie : mesures arrêtées, pic gardé avec la partie.
  session.emit('exit', { code: 0, crashed: false, minutes: 1 });
  await waitFor(() => ipc.win.messages('launch:status').at(-1)?.exited);
  assert.equal(watch.stopped, true);

  const [listed] = await ipc.invoke('instances:list');
  assert.deepEqual(listed.lastLaunch, { startedAt: 1_000_000, prepareMs: 1500, menuMs: 9800, peakMemory: 3.5 * GB });
});

test('mesures du jeu, fenêtre fermée : seul le pic est relu, chaque minute, puis gardé avec la partie', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const ipc = startIpc(t, { account: true });
  const { instance } = await newInstance(ipc);
  await ipc.invoke('instances:update', instance.id, { settings: { ...instance.settings, afterLaunch: 'hide' } });
  await ipc.invoke('launch:start', instance.id, { skipBackup: true });
  const [session] = sessions;
  session.emit('running', { pid: 7 });
  assert.equal(ipc.win, null);
  const [first] = gameMetrics.watches;
  assert.equal(first.stopped, true); // fenêtre fermée tout de suite : pas de mesures fines
  gameMetrics.peaks.set(7, 5 * 1024 ** 3);
  t.mock.timers.tick(60_000);
  await waitFor(() => gameMetrics.peakCalls === 1);
  assert.equal(ipc.win, null);
  assert.equal(ipc.windows[0].messages('launch:metrics').length, 0);

  // Réouverture : mesures fines de nouveau.
  electron.calls.trays[0].click();
  assert.equal(gameMetrics.watches.length, 2);
  assert.equal(gameMetrics.watches[1].stopped, false);
  session.emit('exit', { code: 0, crashed: false, minutes: 1 });
  await waitFor(() => ipc.win.messages('launch:status').at(-1)?.exited);
  assert.equal(gameMetrics.watches[1].stopped, true);
  const [listed] = await ipc.invoke('instances:list');
  assert.equal(listed.lastLaunch.peakMemory, 5 * 1024 ** 3);
});

test('lancement refusé par un Java 32 bits : le code de l’erreur arrive à l’interface', async (t) => {
  const ipc = startIpc(t, { account: true });
  const { instance } = await newInstance(ipc);
  await ipc.invoke('launch:start', instance.id, { skipBackup: true });
  sessions[0].emit('failed', { message: tr('launch.java_32_bits', { ram: '9 Go' }), cancelled: false, code: 'JAVA_32_BIT' });
  assert.deepEqual(wire(ipc.win.messages('launch:status').at(-1)), { run: null, error: tr('launch.java_32_bits', { ram: '9 Go' }), cancelled: false, errorCode: 'JAVA_32_BIT', instanceId: instance.id });
  assert.equal(await ipc.invoke('java:probe', path.join(ipc.root, 'absent.exe')), null);
});

// ---------- Phase 6 : historique des optimisations ----------

test('optimisations : changements de performances notés avec une copie, regroupés, retour en arrière', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 11, 21, 0, 0).getTime() });
  const ipc = startIpc(t, { account: true });
  const { instance, gameDir } = await newInstance(ipc);
  const options = path.join(gameDir, 'options.txt');
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(options, 'renderDistance:12\n');

  // Un réglage sans rapport avec les performances : rien n'est noté.
  await ipc.invoke('instances:update', instance.id, { settings: { ...instance.settings, width: 1600 } });
  assert.deepEqual(await ipc.invoke('optimizations:list', instance.id), []);

  // Mémoire 4 → 6 puis 6 → 9 dans la minute : un seul changement, 4 → 9.
  let current = await ipc.invoke('instances:update', instance.id, { settings: { ...instance.settings, width: 1600, ram: 6 } });
  t.mock.timers.tick(10_000);
  current = await ipc.invoke('instances:update', instance.id, { settings: { ...current.settings, ram: 9 } });
  let list = await ipc.invoke('optimizations:list', instance.id);
  assert.deepEqual(list.map((o) => [o.kind, o.summary]), [['settings', { changes: [{ key: 'ram', from: 4, to: 9 }] }]]);

  // Plus tard : préréglage Java, puis un « pack » qui a ajouté un mod (noté par le service, comme le pack Performances).
  t.mock.timers.tick(120_000);
  fs.writeFileSync(options, 'renderDistance:8\n');
  await ipc.invoke('instances:update', instance.id, { settings: { ...current.settings, jvmPreset: 'zgc' } });
  t.mock.timers.tick(120_000);
  fs.mkdirSync(path.join(gameDir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'mods', 'sodium.jar'), 'jar');
  list = await ipc.invoke('optimizations:list', instance.id);
  assert.equal(list.length, 2);

  // Revenir avant la mémoire : tout ce qui a suivi est annulé aussi.
  const result = await ipc.invoke('optimizations:revert', instance.id, list.at(-1).id);
  assert.equal(result.undone, 2);
  assert.equal(result.instance.settings.ram, 4);
  assert.equal(result.instance.settings.jvmPreset, 'auto');
  assert.equal(result.instance.settings.width, 1600); // réglage d'avant cette copie : gardé
  assert.equal(fs.readFileSync(options, 'utf8'), 'renderDistance:12\n');
  assert.deepEqual(await ipc.invoke('optimizations:list', instance.id), []);
  assert.deepEqual(fs.readdirSync(path.join(ipc.root, 'appdata', '.0rzxn', 'instances', instance.id, '.optimisations')), []);
  await assert.rejects(ipc.invoke('optimizations:revert', instance.id, 12345), { message: tr('ipc.optimisation_introuvable') });
});

test('optimisations : revenir au réglage de départ dans la minute efface le changement ; 10 gardées au plus', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const ipc = startIpc(t);
  const { instance } = await newInstance(ipc);
  await ipc.invoke('instances:update', instance.id, { settings: { ...instance.settings, priority: 'above' } });
  await ipc.invoke('instances:update', instance.id, { settings: { ...instance.settings, priority: 'normal' } });
  assert.deepEqual(await ipc.invoke('optimizations:list', instance.id), []);
  for (let ram = 5; ram <= 16; ram++) {
    t.mock.timers.tick(61_000);
    await ipc.invoke('instances:update', instance.id, { settings: { ...instance.settings, ram } });
  }
  const list = await ipc.invoke('optimizations:list', instance.id);
  assert.equal(list.length, 10);
  assert.deepEqual(list[0].summary.changes, [{ key: 'ram', from: 15, to: 16 }]);
});

test('optimisations : fichiers ajoutés mis à la corbeille au retour en arrière, refusé pendant une partie', async (t) => {
  const ipc = startIpc(t, { account: true });
  const { instance, gameDir } = await newInstance(ipc);
  const { createOptimizations } = require('../src/main/services/optimizations');
  const { openDatabase } = require('../src/main/services/db');
  const { InstanceStore } = require('../src/main/core/instances');
  const { gameDirs } = require('../src/main/core/store');
  // Un second service sur les mêmes instances, appelé comme le pack Performances le fait (record, added, revert).
  const trashed = [];
  const db = openDatabase({ file: path.join(ipc.root, 'config', 'autre.db') });
  const store = new InstanceStore(gameDirs(path.join(ipc.root, 'appdata', '.0rzxn')));
  const service = createOptimizations({ db, instances: store, trash: async (file) => { trashed.push(path.basename(file)); fs.rmSync(file); } });
  const id = service.record(store.get(instance.id), 'perf-pack', { count: 1 });
  fs.mkdirSync(path.join(gameDir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'mods', 'sodium.jar'), 'jar');
  fs.writeFileSync(path.join(gameDir, 'mods', 'garde.jar'), 'jar');
  service.added(id, ['mods/sodium.jar', '../../dehors.jar']);
  const result = await service.revert(instance.id, id);
  assert.equal(result.trashed, 1);
  assert.deepEqual(trashed, ['sodium.jar']);
  assert.ok(fs.existsSync(path.join(gameDir, 'mods', 'garde.jar')));
  db.close(); // avant l'effacement du dossier temporaire (Windows)

  // Pendant une partie : refusé (canal).
  await ipc.invoke('launch:start', instance.id, { skipBackup: true });
  await assert.rejects(ipc.invoke('optimizations:revert', instance.id, 1), { message: tr('ipc.impossible_de_pendant_que_instance', { action: tr('ipc.revenir_avant_optimisation') }) });
});
