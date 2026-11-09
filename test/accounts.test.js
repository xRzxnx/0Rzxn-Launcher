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
