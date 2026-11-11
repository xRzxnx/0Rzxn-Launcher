'use strict';

// Libellés de la page Activité (src/renderer/js/task-labels.js), refaits depuis kind + params dans les trois langues.
// Le module de l'interface est un module ES sans DOM : il suffit d'une fausse fenêtre pour la langue de départ.
const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.window = { launcher: { language: { lang: 'fr', locale: 'fr-FR' } } };
globalThis.document = { documentElement: {} };

const load = async () => {
  const i18n = await import('../src/renderer/js/i18n.js');
  const labels = await import('../src/renderer/js/task-labels.js');
  return { ...i18n, ...labels };
};
const LOCALES = { fr: 'fr-FR', en: 'en-US', es: 'es-ES' };
// Espaces insécables (formats Intl) remplacées par des espaces ordinaires pour comparer.
const plain = (text) => text.replace(/[\u00a0\u202f]/g, ' ');

const instances = [{ id: 'survie', name: 'Survie 1.21' }];
const TASKS = {
  install: { kind: 'modpack-install', label: 'Installation de Vieux nom', instanceId: null, params: { title: 'Fabulously Optimized' } },
  update: { kind: 'modpack-update', label: 'x', instanceId: 'survie', params: { versionId: 'v', name: 'Ancien nom' } },
  updateGone: { kind: 'modpack-update', label: 'x', instanceId: 'supprimee', params: { versionId: 'v', name: 'Ancien nom' } },
  backup: { kind: 'world-backup', label: 'x', instanceId: 'survie', params: { folder: 'Mundo 2' } },
  launch: { kind: 'launch-prepare', label: 'x', instanceId: 'survie', state: 'running', params: { name: 'Survie 1.21', prepareOnly: false }, progress: { step: 3, done: 1, total: 2 } },
  profile: { kind: 'profile-mods', label: 'x', instanceId: 'survie', params: { profileId: 'survival' } },
  unknown: { kind: 'futur', label: 'Libellé enregistré', instanceId: null, params: null },
};

const EXPECTED = {
  fr: {
    install: 'Installation de Fabulously Optimized',
    update: 'Mise à jour de Survie 1.21',
    updateGone: 'Mise à jour de Ancien nom',
    backup: 'Sauvegarde de Mundo 2',
    launch: 'Préparation de la partie',
    profile: 'Mods du profil Survie optimisée',
    launchWhere: 'Survie 1.21 · étape 4 sur 9 : Java',
    facts: ['3 / 10 fichiers', '1,5 Mo / 3 Mo', '512 Ko/s', 'reste 1 min 5 s'],
    done: 'Survie 1.21 · 25 fichiers · 16 Mo · 4 s',
    cancelled: 'Survie 1.21 · Annulée après 2 s',
    failed: 'Survie 1.21 · 3 / 7 fichiers',
    today: 'Aujourd’hui, 21:13',
    yesterday: 'Hier, 22:05',
  },
  en: {
    install: 'Installing Fabulously Optimized',
    update: 'Updating Survie 1.21',
    updateGone: 'Updating Ancien nom',
    backup: 'Backing up Mundo 2',
    launch: 'Preparing the game',
    profile: 'Mods for the Optimized survival profile',
    launchWhere: 'Survie 1.21 · step 4 of 9: Java',
    facts: ['3 / 10 files', '1.5 MB / 3 MB', '512 KB/s', '1 min 5 s left'],
    done: 'Survie 1.21 · 25 files · 16 MB · 4 s',
    cancelled: 'Survie 1.21 · Cancelled after 2 s',
    failed: 'Survie 1.21 · 3 / 7 files',
    today: 'Today, 09:13 PM',
    yesterday: 'Yesterday, 10:05 PM',
  },
  es: {
    install: 'Instalación de Fabulously Optimized',
    update: 'Actualización de Survie 1.21',
    updateGone: 'Actualización de Ancien nom',
    backup: 'Copia de seguridad de Mundo 2',
    launch: 'Preparando la partida',
    profile: 'Mods del perfil Supervivencia optimizada',
    launchWhere: 'Survie 1.21 · paso 4 de 9: Java',
    facts: ['3 / 10 archivos', '1,5 MB / 3 MB', '512 KB/s', 'quedan 1 min 5 s'],
    done: 'Survie 1.21 · 25 archivos · 16 MB · 4 s',
    cancelled: 'Survie 1.21 · Cancelada tras 2 s',
    failed: 'Survie 1.21 · 3 / 7 archivos',
    today: 'Hoy, 21:13',
    yesterday: 'Ayer, 22:05',
  },
};

for (const lang of ['fr', 'en', 'es']) {
  test(`libellés de la page Activité en ${lang}`, async () => {
    const m = await load();
    await m.setLanguage({ lang, locale: LOCALES[lang] });
    const want = EXPECTED[lang];
    for (const name of ['install', 'update', 'updateGone', 'backup', 'launch']) assert.equal(m.taskName(TASKS[name], instances), want[name], name);
    // Le titre du profil vient du dictionnaire de l'assistant : seulement vérifié s'il est traduit comme attendu.
    assert.equal(m.taskName(TASKS.profile, instances), m.t('activity.mods_du_profil', { title: m.t('wizard.survie_optimisee') }));
    assert.equal(m.taskName(TASKS.unknown, instances), 'Libellé enregistré');
    assert.equal(m.taskWhere(TASKS.launch, instances), want.launchWhere);
    assert.deepEqual(m.progressFacts({ progress: { done: 3, total: 10, doneBytes: 1.5 * 1024 * 1024, totalBytes: 3 * 1024 * 1024, speed: 512 * 1024, eta: 65 } }).map(plain), want.facts);

    const base = { kind: 'modpack-update', instanceId: 'survie', params: {}, startedAt: 1000 };
    assert.equal(plain(m.historyDetail({ ...base, state: 'done', endedAt: 5000, progress: { done: 25, total: 25, totalBytes: 15.5 * 1024 * 1024 } }, instances)), want.done);
    assert.equal(m.historyDetail({ ...base, state: 'cancelled', endedAt: 3000, progress: null }, instances), want.cancelled);
    assert.equal(m.historyDetail({ ...base, state: 'failed', endedAt: 3000, progress: { done: 3, total: 7 } }, instances), want.failed);

    const now = new Date(2026, 10, 11, 23, 0).getTime();
    assert.equal(plain(m.formatWhen(new Date(2026, 10, 11, 21, 13).getTime(), now)), want.today);
    assert.equal(plain(m.formatWhen(new Date(2026, 10, 10, 22, 5).getTime(), now)), want.yesterday);
  });
}

test('progression : fichiers, octets, ou étapes d’une partie ; résumé de la barre latérale', async () => {
  const m = await load();
  assert.equal(m.taskPercent({ kind: 'x', progress: { done: 0, total: 0 } }), null);
  assert.equal(m.taskPercent({ kind: 'x', progress: { done: 1, total: 4 } }), 25);
  assert.equal(m.taskPercent({ kind: 'x', progress: { done: 1, total: 4, doneBytes: 300, totalBytes: 1000 } }), 30);
  assert.equal(m.taskPercent({ kind: 'launch-prepare', progress: { step: 3, done: 1, total: 2 } }), 39);
  assert.deepEqual(
    m.activitySummary([
      { state: 'running', kind: 'x', progress: { done: 1, total: 2 } },
      { state: 'running', kind: 'x', progress: { done: 0, total: 0 } },
      { state: 'queued', kind: 'x', progress: { done: 0, total: 0 } },
      { state: 'running', kind: 'temp-cleanup', hidden: true, progress: { done: 9, total: 10 } },
    ]),
    { count: 3, running: 2, queued: 1, percent: 25 },
  );
  assert.equal(m.taskFamily('world-restore'), 'save');
  assert.equal(m.taskFamily('launch-prepare'), 'play');
  assert.equal(m.taskFamily('modpack-install'), 'pack');
  assert.equal(m.formatDuration(3_725_000).replace(/\s/g, ' '), m.t('activity.heures', { h: 1, m: '02' }));
});
