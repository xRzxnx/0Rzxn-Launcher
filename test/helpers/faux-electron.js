'use strict';

// Faux module « electron » pour tester le processus principal avec node:test, sans ouvrir de fenêtre.
// Les objets gardent la même identité d'un test à l'autre (les modules les déstructurent au chargement) :
// reset() remet seulement leur état à zéro.
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const calls = {
  handlers: new Map(), // canal → fonction enregistrée par ipcMain.handle
  protocols: new Map(), // schéma → fonction enregistrée par protocol.handle
  trashed: [],
  opened: [],
  shortcuts: [],
  dialogs: [],
};
const paths = {};

const app = {
  getPath: (name) => {
    if (!paths[name]) throw new Error(`faux-electron: unknown path ${name}`);
    return paths[name];
  },
  getVersion: () => '0.4.0',
  getName: () => '0Rzxn_ Launcher',
  getAppPath: () => paths.appPath,
  getPreferredSystemLanguages: () => ['fr-FR'],
  getAppMetrics: () => [],
  isPackaged: false,
  quit() {},
};

const dialog = {
  next: null, // réponse du prochain dialogue, sinon « annulé »
  answer(kind, options) {
    calls.dialogs.push({ kind, options });
    const value = dialog.next ?? (kind === 'message' ? { response: 0 } : { canceled: true, filePaths: [] });
    dialog.next = null;
    return Promise.resolve(value);
  },
  showOpenDialog: (_win, options) => dialog.answer('open', options),
  showSaveDialog: (_win, options) => dialog.answer('save', options),
  showMessageBox: (_win, options) => dialog.answer('message', options),
};

const ipcMain = {
  handle(channel, fn) {
    if (calls.handlers.has(channel)) throw new Error(`faux-electron: channel registered twice: ${channel}`);
    calls.handlers.set(channel, fn);
  },
};

const protocol = {
  handle(scheme, fn) {
    calls.protocols.set(scheme, fn);
  },
  registerSchemesAsPrivileged() {},
};

// Chiffrement réversible et lisible : suffit pour vérifier que les jetons passent par le coffre.
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`chiffre:${text}`),
  decryptString: (buffer) => buffer.toString().replace(/^chiffre:/, ''),
};

const shell = {
  trashItem: async (file) => {
    calls.trashed.push(file);
    fs.rmSync(file, { recursive: true, force: true });
  },
  openPath: async (file) => {
    calls.opened.push(file);
    return '';
  },
  openExternal: async () => {},
  writeShortcutLink: (file, operation, options) => {
    calls.shortcuts.push({ file, operation, options });
    return true;
  },
};

class Tray {
  constructor(image) {
    this.image = image;
    this.tooltip = null;
  }
  on() {}
  setImage(image) {
    this.image = image;
  }
  setToolTip(text) {
    this.tooltip = text;
  }
  popUpContextMenu() {}
  displayBalloon() {}
  destroy() {}
}

const electron = {
  app,
  dialog,
  ipcMain,
  protocol,
  safeStorage,
  shell,
  Tray,
  Menu: { buildFromTemplate: (items) => ({ items }), setApplicationMenu() {} },
  nativeImage: { createFromPath: (file) => ({ file }) },
  BrowserWindow: class BrowserWindow {},
  calls,
  /** Remet tout à zéro, avec des dossiers neufs sous `root`. */
  reset(root) {
    for (const value of Object.values(calls)) (value instanceof Map ? value.clear() : value.splice(0));
    dialog.next = null;
    Object.assign(paths, {
      userData: path.join(root, 'config'),
      appData: path.join(root, 'appdata'),
      desktop: path.join(root, 'bureau'),
      pictures: path.join(root, 'images'),
      appPath: path.join(root, 'projet'),
    });
    for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });
  },
};

/** Fausse fenêtre : retient les messages envoyés à l'interface. */
function fakeWindow() {
  const win = {
    sent: [], // [canal, contenu]
    visible: true,
    minimized: false,
    shown: 0,
    webContents: {
      // Copie au moment de l'envoi, comme Electron : un objet modifié ensuite ne change pas le message déjà parti.
      send: (channel, payload) => win.sent.push([channel, payload === undefined ? undefined : structuredClone(payload)]),
      setBackgroundThrottling() {},
    },
    isDestroyed: () => false,
    isVisible: () => win.visible,
    isMinimized: () => win.minimized,
    isFocused: () => true,
    minimize() {
      win.minimized = true;
    },
    hide() {
      win.visible = false;
    },
    show() {
      win.visible = true;
      win.shown += 1;
    },
    restore() {
      win.minimized = false;
    },
    focus() {},
    /** Messages envoyés sur un canal, dans l'ordre. */
    messages: (channel) => win.sent.filter(([c]) => c === channel).map(([, payload]) => payload),
  };
  return win;
}

const load = Module._load;
Module._load = function loadWithFakeElectron(request, ...rest) {
  return request === 'electron' ? electron : load.call(this, request, ...rest);
};

/** Dossier temporaire, effacé à la fin du test ; `before` passe d'abord (fermer ce qui y tient des fichiers ouverts). */
function tempRoot(t, before = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '0rzxn-ipc-'));
  t.after(() => {
    before();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

module.exports = { electron, fakeWindow, tempRoot };
