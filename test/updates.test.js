'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { UpdateManager, isPrerelease } = require('../src/main/core/updates');
const { resolveLanguage, setLanguage, t: tr } = require('../src/main/i18n');

setLanguage(resolveLanguage('fr'));

/** Faux electron-updater : la prochaine version trouvée et le résultat du téléchargement sont réglables. */
function fakeUpdater() {
  const updater = new EventEmitter();
  Object.assign(updater, {
    next: null,
    downloadError: null,
    checks: [],
    async checkForUpdates() {
      updater.checks.push({ allowPrerelease: updater.allowPrerelease, allowDowngrade: updater.allowDowngrade });
      return updater.next ? { isUpdateAvailable: true, updateInfo: { version: updater.next } } : { isUpdateAvailable: false };
    },
    async downloadUpdate() {
      if (updater.downloadError) throw updater.downloadError;
      updater.emit('update-downloaded', { version: updater.next });
    },
    quitAndInstall() {},
  });
  return updater;
}

function manager({ channel = 'stable', busy = false } = {}) {
  const updater = fakeUpdater();
  const settings = { channel, automatic: true, busy };
  const states = [];
  const m = new UpdateManager({
    supported: true,
    loadUpdater: () => updater,
    isBusy: () => settings.busy,
    isAutomatic: () => settings.automatic,
    channel: () => settings.channel,
    onState: (s) => states.push(s),
  });
  return { m, updater, settings, states };
}

const signatureError = () => Object.assign(new Error('New version 0.6.1 is not signed by the application owner'), { code: 'ERR_UPDATER_INVALID_SIGNATURE' });

test('isPrerelease reconnaît les versions bêta', () => {
  assert.equal(isPrerelease('0.6.0-beta.1'), true);
  assert.equal(isPrerelease('0.6.0'), false);
  assert.equal(isPrerelease(null), false);
});

test('le réglage décide de allowPrerelease à chaque recherche', async () => {
  const { m, updater, settings } = manager();
  updater.allowPrerelease = true; // ce que fait electron-updater sur une version installée bêta
  await m.check();
  settings.channel = 'beta';
  await m.check();
  assert.deepEqual(updater.checks, [{ allowPrerelease: false, allowDowngrade: false }, { allowPrerelease: true, allowDowngrade: false }]);
});

test('une bêta trouvée en canal bêta est téléchargée et prête', async () => {
  const { m, updater } = manager({ channel: 'beta' });
  updater.next = '0.6.0-beta.1';
  const state = await m.check({ manual: true });
  assert.equal(state.status, 'ready');
  assert.equal(state.version, '0.6.0-beta.1');
  assert.equal(updater.autoInstallOnAppQuit, true);
});

test('repasser en stable : une bêta prête ne s installe plus, une recherche repart', async () => {
  const { m, updater, settings } = manager({ channel: 'beta' });
  updater.next = '0.6.0-beta.1';
  await m.check();
  settings.channel = 'stable';
  updater.next = null;
  m.channelChanged();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(m.state.status, 'current');
  assert.equal(updater.checks.at(-1).allowPrerelease, false);
});

test('une bêta finie de télécharger après le retour en stable est écartée', async () => {
  const { m, updater, settings } = manager({ channel: 'beta' });
  updater.next = '0.6.0-beta.1';
  updater.downloadUpdate = async () => {
    settings.channel = 'stable';
    updater.emit('update-downloaded', { version: '0.6.0-beta.1' });
  };
  const state = await m.check();
  assert.equal(state.status, 'idle');
  assert.equal(updater.autoInstallOnAppQuit, false);
});

test('une stable prête reste prête quand le réglage change', async () => {
  const { m, updater, settings } = manager({ channel: 'beta' });
  updater.next = '0.6.0';
  await m.check();
  settings.channel = 'stable';
  m.channelChanged();
  assert.equal(m.state.status, 'ready');
  assert.equal(updater.autoInstallOnAppQuit, true);
});

test('signature refusée : message visible même en recherche automatique, sans retéléchargement', async () => {
  const { m, updater } = manager();
  updater.next = '0.6.1';
  let downloads = 0;
  updater.downloadUpdate = async () => {
    downloads += 1;
    throw signatureError();
  };
  let state = await m.check();
  assert.equal(state.status, 'error');
  assert.equal(state.error, tr('update.err_signature', { version: '0.6.1' }));
  state = await m.check();
  assert.equal(state.status, 'error');
  assert.equal(downloads, 1);
  await m.check({ manual: true }); // une recherche demandée réessaie
  assert.equal(downloads, 2);
});

test('les autres erreurs automatiques restent silencieuses', async () => {
  const { m, updater } = manager();
  updater.next = '0.6.1';
  updater.downloadError = new Error('net::ERR_INTERNET_DISCONNECTED');
  assert.equal((await m.check()).status, 'idle');
  assert.equal((await m.check({ manual: true })).error, tr('update.err_network'));
});

test('macOS : la nouvelle version est seulement annoncée, jamais téléchargée ni installée', async () => {
  const updater = fakeUpdater();
  let downloads = 0;
  updater.downloadUpdate = async () => { downloads += 1; };
  const settings = { channel: 'stable' };
  const m = new UpdateManager({ supported: true, canInstall: false, loadUpdater: () => updater, isBusy: () => false, isAutomatic: () => true, channel: () => settings.channel, onState() {} });
  updater.next = '0.6.0';
  const state = await m.check({ manual: true });
  assert.equal(state.status, 'available');
  assert.equal(state.version, '0.6.0');
  assert.equal(downloads, 0);
  assert.throws(() => m.install(), { message: tr('update.none_ready') });
  // Une version plus récente sort : la recherche suivante la trouve.
  updater.next = '0.6.1';
  assert.equal((await m.check()).version, '0.6.1');
  // Bêta annoncée puis retour en stable : elle n'est plus proposée.
  settings.channel = 'beta';
  updater.next = '0.7.0-beta.1';
  assert.equal((await m.check()).status, 'available');
  settings.channel = 'stable';
  updater.next = null;
  m.channelChanged();
  await new Promise((r) => setImmediate(r));
  assert.notEqual(m.state.version, '0.7.0-beta.1');
});
