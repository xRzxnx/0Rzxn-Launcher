'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccountStore, offlineUuid } = require('../src/main/core/accounts');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '0rzxn-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('offlineUuid : même UUID que Minecraft (v3 de « OfflinePlayer:<pseudo> »)', () => {
  // Valeur de référence connue pour « Notch ».
  assert.equal(offlineUuid('Notch'), 'b50ad385829d3141a2167e7d7539ba7f');
  const uuid = offlineUuid('0Rzxn_');
  assert.match(uuid, /^[0-9a-f]{32}$/);
  assert.equal(uuid[12], '3'); // version 3
  assert.match(uuid[16], /[89ab]/); // variante RFC 4122
  // La casse compte, comme dans le jeu.
  assert.notEqual(offlineUuid('notch'), offlineUuid('Notch'));
});

test('AccountStore : compte hors-ligne seulement après un compte Microsoft', (t) => {
  const dir = tempDir(t);
  const store = new AccountStore(dir);
  assert.throws(() => store.addOffline('Joueur'));

  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ activeId: 'ms-1', accounts: [{ id: 'ms-1', type: 'microsoft', name: 'Officiel', uuid: 'f'.repeat(32) }] }));
  const withMicrosoft = new AccountStore(dir);
  const list = withMicrosoft.addOffline('  Joueur_2 ');
  const added = list.accounts.find((a) => a.type === 'offline');
  assert.equal(added.name, 'Joueur_2');
  assert.equal(added.uuid, offlineUuid('Joueur_2'));
  assert.equal(list.activeId, `offline-${added.uuid}`);
  // Enregistré sur le disque.
  assert.equal(new AccountStore(dir).list().accounts.length, 2);
});

test('AccountStore : pseudos invalides ou en double refusés', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ activeId: null, accounts: [{ id: 'ms-1', type: 'microsoft', name: 'Officiel', uuid: 'f'.repeat(32) }] }));
  const store = new AccountStore(dir);
  for (const name of ['ab', 'a'.repeat(17), 'avec espace', 'accentué', '', null]) assert.throws(() => store.addOffline(name), undefined, String(name));
  store.addOffline('Joueur');
  assert.throws(() => store.addOffline('JOUEUR'));
});

// ---------- Linux sans trousseau (phase 9) ----------

const SESSION = { uuid: '0123456789abcdef0123456789abcdef', name: 'Ana', xuid: '42', refreshToken: 'r1', accessToken: 'a1', expiresAt: Date.now() + 3_600_000 };

test('AccountStore sans trousseau : jetons en mémoire seulement, compte à reconnecter au redémarrage', async (t) => {
  const dir = tempDir(t);
  const vault = { persistent: () => false, encrypt: () => { throw new Error('jamais'); }, decrypt: () => { throw new Error('jamais'); } };
  const store = new AccountStore(dir, { vault });
  const list = store.addMicrosoft(SESSION);
  assert.deepEqual(list.accounts.map((a) => [a.type, a.needsLogin, a.sessionOnly]), [['microsoft', false, true]]);
  // Le jeton marche pendant la session…
  assert.equal((await store.launchAccount()).accessToken, 'a1');
  // … mais n'est jamais écrit sur le disque.
  const onDisk = fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8');
  assert.ok(!onDisk.includes('a1') && !onDisk.includes('r1') && !onDisk.includes('secrets'), onDisk);
  // Le hors-ligne reste possible, et le fichier garde le compte (nom, uuid) marqué « à reconnecter ».
  store.addOffline('Bob');
  const reopened = new AccountStore(dir, { vault });
  const ana = reopened.list().accounts.find((a) => a.type === 'microsoft');
  assert.deepEqual([ana.name, ana.needsLogin, ana.sessionOnly], ['Ana', true, true]);
  await assert.rejects(reopened.launchAccount(() => {}, ana.id));
});

test('AccountStore avec trousseau : rien ne change, sessionOnly absent', (t) => {
  const dir = tempDir(t);
  const store = new AccountStore(dir, { vault: { persistent: () => true, encrypt: (s) => `enc:${s}`, decrypt: (s) => s.slice(4) } });
  const [account] = store.addMicrosoft(SESSION).accounts;
  assert.equal('sessionOnly' in account, false);
  assert.match(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'), /"secrets": "enc:/);
});

test('coffre : Linux en « basic_text » ne protège pas les jetons, les autres systèmes oui', () => {
  require('./helpers/faux-electron');
  const { persistent } = require('../src/main/services/vault');
  const storage = (backend, available = true) => ({ isEncryptionAvailable: () => available, getSelectedStorageBackend: () => backend });
  assert.equal(persistent({ platform: 'linux', storage: storage('basic_text') }), false);
  assert.equal(persistent({ platform: 'linux', storage: storage('gnome_libsecret') }), true);
  assert.equal(persistent({ platform: 'linux', storage: storage('kwallet6') }), true);
  assert.equal(persistent({ platform: 'win32', storage: storage('unknown') }), true);
  assert.equal(persistent({ platform: 'darwin', storage: storage('unknown') }), true);
  assert.equal(persistent({ platform: 'win32', storage: storage('unknown', false) }), false);
});
