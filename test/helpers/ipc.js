'use strict';

// Démarre les canaux du processus principal avec le faux Electron, dans un dossier temporaire.
// Le jeu n'est jamais lancé : LaunchSession.start et stop sont remplacés, les sessions créées sont gardées dans `sessions`.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { electron, fakeWindow, tempRoot } = require('./faux-electron');
const { LaunchSession } = require('../../src/main/core/launch');

const sessions = [];
LaunchSession.prototype.start = function start() {
  sessions.push(this);
};
LaunchSession.prototype.stop = function stop() {
  this.stopped = true;
};

const { registerIpc } = require('../../src/main/ipc');

const OFFLINE = { id: 'offline-test', type: 'offline', name: 'Testeur', uuid: '00000000000030008000000000000001' };

/** `account` : un compte hors ligne actif, nécessaire pour lancer une instance. */
function startIpc(t, { account = false } = {}) {
  const root = tempRoot(t);
  electron.reset(root);
  sessions.splice(0);
  if (account) {
    fs.writeFileSync(path.join(root, 'config', 'accounts.json'), JSON.stringify({ activeId: OFFLINE.id, accounts: [OFFLINE] }));
  }
  const win = fakeWindow();
  const hooks = registerIpc(() => win);
  t.after(() => hooks.beforeQuit());
  const invokeAs = async (sender, channel, ...args) => {
    const handler = electron.calls.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({ sender }, ...args);
  };
  return {
    root,
    win,
    hooks,
    invokeAs,
    invoke: (channel, ...args) => invokeAs(win.webContents, channel, ...args),
  };
}

// Petit level.dat (NBT compressé) : juste ce qu'il faut pour qu'un dossier soit reconnu comme un monde.
const u8 = (n) => Buffer.from([n & 0xff]);
const str = (s) => {
  const data = Buffer.from(s, 'utf8');
  const size = Buffer.alloc(2);
  size.writeInt16BE(data.length);
  return Buffer.concat([size, data]);
};
const tag = (type, name, payload) => Buffer.concat([u8(type), str(name), payload]);
const compound = (...tags) => Buffer.concat([...tags, u8(0)]);

function makeWorld(gameDir, folder, name = folder) {
  const dir = path.join(gameDir, 'saves', folder);
  fs.mkdirSync(path.join(dir, 'region'), { recursive: true });
  const level = Buffer.concat([u8(10), str(''), compound(tag(10, 'Data', compound(tag(8, 'LevelName', str(name)))))]);
  fs.writeFileSync(path.join(dir, 'level.dat'), zlib.gzipSync(level));
  fs.writeFileSync(path.join(dir, 'region', 'r.0.0.mca'), Buffer.alloc(4096, 7));
  return dir;
}

/** Laisse passer les promesses en cours (setImmediate n'est pas remplacé par les faux minuteurs). */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Attend qu'une condition devienne vraie (lectures de fichiers en cours), sans dépendre des minuteurs. */
async function waitFor(condition, tries = 5000) {
  for (let i = 0; i < tries; i++) {
    if (condition()) return;
    await settle();
  }
  throw new Error('waitFor: condition never met');
}

/** Comme le transport d'Electron : les propriétés « undefined » ne comptent pas. */
const wire = (value) => JSON.parse(JSON.stringify(value));

module.exports = { startIpc, sessions, makeWorld, settle, waitFor, wire, electron };
