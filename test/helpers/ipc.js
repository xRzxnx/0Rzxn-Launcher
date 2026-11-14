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

// Mesures du jeu : jamais de vrai PowerShell dans les tests ; `gameMetrics` donne la main sur les mesures.
const platform = require('../../src/main/platform');
const gameMetrics = {
  watches: [], // { pid, onSample, stopped }
  peaks: new Map(), // pid → pic renvoyé par peak()
  peakCalls: 0,
  reset() {
    this.watches.splice(0);
    this.peaks.clear();
    this.peakCalls = 0;
  },
};
platform.processMetrics = {
  supported: true,
  watch(pid, { onSample }) {
    const watch = { pid, onSample, stopped: false };
    gameMetrics.watches.push(watch);
    return { stop: () => { watch.stopped = true; } };
  },
  async peak(pid) {
    gameMetrics.peakCalls += 1;
    return gameMetrics.peaks.get(pid) ?? null;
  },
};
// Zone de notification : toujours là dans les tests, quel que soit le bureau de la machine (CI Linux sans session).
platform.trayAvailable = async () => true;

const { registerIpc } = require('../../src/main/ipc');

const OFFLINE = { id: 'offline-test', type: 'offline', name: 'Testeur', uuid: '00000000000030008000000000000001' };

/**
 * `account` : un compte hors ligne actif, nécessaire pour lancer une instance.
 * La fenêtre peut être fermée et recréée comme dans main.js (`ipc.win` suit la fenêtre du moment, null quand elle est fermée).
 */
function startIpc(t, { account = false } = {}) {
  let hooks = null;
  // launcher.db reste ouverte jusqu'à la fermeture du launcher : fermée avant d'effacer le dossier.
  const root = tempRoot(t, () => hooks?.beforeQuit());
  electron.reset(root);
  sessions.splice(0);
  gameMetrics.reset();
  if (account) {
    fs.writeFileSync(path.join(root, 'config', 'accounts.json'), JSON.stringify({ activeId: OFFLINE.id, accounts: [OFFLINE] }));
  }
  let win = fakeWindow();
  const windows = [win];
  const windowControl = {
    open() {
      if (win) return win;
      win = fakeWindow();
      windows.push(win);
      hooks.windowCreated();
      return win;
    },
    close() {
      win = null;
    },
  };
  hooks = registerIpc(() => win, windowControl);
  const invokeAs = async (sender, channel, ...args) => {
    const handler = electron.calls.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({ sender }, ...args);
  };
  return {
    root,
    get win() {
      return win;
    },
    windows,
    hooks,
    invokeAs,
    invoke: (channel, ...args) => invokeAs((win ?? windows.at(-1)).webContents, channel, ...args),
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

module.exports = { startIpc, sessions, makeWorld, settle, waitFor, wire, electron, gameMetrics };
