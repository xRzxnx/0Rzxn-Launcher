'use strict';

// Connexion Microsoft. Par défaut dans le navigateur habituel (phase 7) : la page officielle de Microsoft
// renvoie le navigateur vers une adresse locale du launcher (core/loopback.js). En secours, la même page
// dans une fenêtre intégrée isolée. Dans les deux cas, le launcher ne voit jamais le mot de passe :
// il récupère seulement le code renvoyé à la fin. Une seule connexion à la fois.
const { t } = require('./i18n');
const { BrowserWindow, shell } = require('electron');
const microsoft = require('./core/microsoft');
const { MicrosoftAuthError, createAuthorization, parseRedirect, REDIRECT_URI } = microsoft;
const { openLoopback, WAIT_MS } = require('./core/loopback');
const { journal } = require('./core/journal');

let openWindow = null;
/** Connexion en cours : { mode, url, reopen(), useWindow(), cancel() }. */
let current = null;

/** Ramène la fenêtre du launcher au premier plan ; si Windows refuse le focus, la fait clignoter dans la barre des tâches. */
function bringForward(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (!win.isFocused()) {
    win.flashFrame(true);
    win.once('focus', () => !win.isDestroyed() && win.flashFrame(false));
  }
}

/** Fenêtre intégrée : ouvre la page de connexion et renvoie { code, verifier, redirectUri } quand l'utilisateur a terminé. */
function promptWindowLogin(parent, clientId) {
  if (openWindow && !openWindow.isDestroyed()) {
    openWindow.focus();
    return Promise.reject(new MicrosoftAuthError(t('microsoft.une_fenetre_de_connexion_est'), 'BUSY'));
  }
  const { url, verifier, state } = createAuthorization(clientId);

  return new Promise((resolve, reject) => {
    let settled = false;
    const win = new BrowserWindow({
      parent,
      modal: true,
      width: 520,
      height: 700,
      title: t('microsoft.connexion_microsoft'),
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        partition: 'persist:microsoft', // garde la session Microsoft pour « choisir un compte » la prochaine fois
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    openWindow = win;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
      if (!win.isDestroyed()) win.close();
    };

    // Intercepte le retour vers l'adresse de redirection, sans la charger.
    const check = (event, target) => {
      let result;
      try {
        result = parseRedirect(target, state);
      } catch (error) {
        event?.preventDefault();
        finish(error);
        return;
      }
      if (!result) return;
      event?.preventDefault();
      finish(null, { code: result.code, verifier, redirectUri: REDIRECT_URI });
    };
    win.webContents.on('will-redirect', check);
    win.webContents.on('will-navigate', check);
    win.webContents.on('did-navigate', (_event, target) => check(null, target));

    // Liens « Créer un compte », « Aide »… : dans le navigateur.
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (target.startsWith('https://')) shell.openExternal(target);
      return { action: 'deny' };
    });
    win.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
      if (isMainFrame && code !== -3 && !failedUrl.startsWith(REDIRECT_URI)) {
        finish(new MicrosoftAuthError(t('microsoft.la_page_de_connexion_ne', { description }), 'NETWORK'));
      }
    });
    win.on('closed', () => {
      openWindow = null;
      finish(new MicrosoftAuthError(t('microsoft.connexion_annulee'), 'CANCELLED'));
    });

    win.loadURL(url);
  });
}

const USE_WINDOW = Symbol('fenetre');

/**
 * Connexion dans le navigateur. Renvoie la session, ou null pour passer à la fenêtre intégrée
 * (demandé par l'utilisateur, ou adresse locale / navigateur indisponible).
 */
async function browserLogin(entry, { clientId, getWindow, send }) {
  const state = microsoft.newState();
  let loopback;
  try {
    loopback = await openLoopback({ state });
  } catch (error) {
    journal.warn('Microsoft login: loopback unavailable, using the embedded window:', error);
    return null;
  }
  const { url, verifier } = createAuthorization(clientId, { redirectUri: loopback.redirectUri, state });
  try {
    await shell.openExternal(url);
  } catch (error) {
    journal.warn('Microsoft login: browser did not open, using the embedded window:', error);
    loopback.close();
    return null;
  }

  let useWindow;
  const switched = new Promise((resolve) => { useWindow = () => resolve(USE_WINDOW); });
  Object.assign(entry, {
    mode: 'browser',
    url,
    reopen: () => shell.openExternal(url),
    useWindow,
    cancel: () => loopback.close(),
  });
  send('accounts:loginState', { phase: 'browser', url, expiresAt: Date.now() + WAIT_MS });

  try {
    const result = await Promise.race([loopback.wait, switched]);
    if (result === USE_WINDOW) {
      loopback.close();
      return null;
    }
    // Code reçu : la page du navigateur attend le vrai résultat (Xbox, Minecraft, profil).
    Object.assign(entry, { reopen: null, useWindow: null, cancel: null });
    send('accounts:loginState', { phase: 'checking' });
    const session = await microsoft.signIn(clientId, result.code, verifier, loopback.redirectUri);
    loopback.respond({ kind: 'ok', name: session.name });
    bringForward(getWindow());
    return session;
  } catch (error) {
    loopback.respond({ kind: 'error', code: error.code, message: error.message });
    if (error.code !== 'CANCELLED' && error.code !== 'TIMEOUT') bringForward(getWindow());
    throw error;
  }
}

/** Connexion dans la fenêtre intégrée (secours). */
async function windowLogin(entry, { clientId, getWindow, send }) {
  Object.assign(entry, { mode: 'window', url: null, reopen: null, useWindow: null, cancel: () => openWindow?.close() });
  send('accounts:loginState', { phase: 'window' });
  const { code, verifier, redirectUri } = await promptWindowLogin(getWindow(), clientId);
  entry.cancel = null;
  send('accounts:loginState', { phase: 'checking' });
  return microsoft.signIn(clientId, code, verifier, redirectUri);
}

/**
 * Connexion complète jusqu'au profil Minecraft. `mode` : 'browser' (par défaut) ou 'window'.
 * `send(canal, contenu)` envoie l'état à l'interface (« accounts:loginState »).
 */
async function signInMicrosoft({ clientId, getWindow, send, mode = 'browser' }) {
  if (current) {
    if (current.mode === 'window') openWindow?.focus();
    throw new MicrosoftAuthError(t('microsoft.une_fenetre_de_connexion_est'), 'BUSY');
  }
  const entry = { mode, url: null, reopen: null, useWindow: null, cancel: null };
  current = entry;
  try {
    if (mode !== 'window') {
      const session = await browserLogin(entry, { clientId, getWindow, send });
      if (session) return session;
    }
    return await windowLogin(entry, { clientId, getWindow, send });
  } finally {
    current = null;
    send('accounts:loginState', { phase: 'idle' });
  }
}

/** Boutons du bloc d'attente : rouvrir la page, passer à la fenêtre intégrée, annuler. Renvoient false s'il n'y a rien à faire. */
const loginControls = {
  reopen() {
    if (!current?.reopen) return false;
    current.reopen().catch((error) => journal.warn('Microsoft login: reopen failed:', error));
    return true;
  },
  useWindow() {
    if (!current?.useWindow) return false;
    current.useWindow();
    return true;
  },
  cancel() {
    if (!current?.cancel) return false;
    current.cancel();
    return true;
  },
};

module.exports = { signInMicrosoft, loginControls, promptWindowLogin };
