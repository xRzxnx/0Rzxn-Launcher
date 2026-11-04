'use strict';

// Fenêtre de connexion Microsoft : la page officielle de Microsoft, ouverte dans une fenêtre isolée.
// Le launcher ne voit jamais le mot de passe : il récupère seulement le code renvoyé à la fin.
const { BrowserWindow, shell } = require('electron');
const { MicrosoftAuthError, createAuthorization, parseRedirect } = require('./core/microsoft');

let openWindow = null;

/** Ouvre la page de connexion et renvoie { code, verifier } quand l'utilisateur a terminé. */
function promptMicrosoftLogin(parent, clientId) {
  if (openWindow && !openWindow.isDestroyed()) {
    openWindow.focus();
    return Promise.reject(new MicrosoftAuthError('Une fenêtre de connexion est déjà ouverte.', 'BUSY'));
  }
  const { url, verifier, state } = createAuthorization(clientId);

  return new Promise((resolve, reject) => {
    let settled = false;
    const win = new BrowserWindow({
      parent,
      modal: true,
      width: 520,
      height: 700,
      title: 'Connexion Microsoft',
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
      finish(null, { code: result.code, verifier });
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
      if (isMainFrame && code !== -3 && !failedUrl.startsWith('https://login.microsoftonline.com/common/oauth2/nativeclient')) {
        finish(new MicrosoftAuthError(`La page de connexion ne s'est pas chargée (${description}).`, 'NETWORK'));
      }
    });
    win.on('closed', () => {
      openWindow = null;
      finish(new MicrosoftAuthError('Connexion annulée.', 'CANCELLED'));
    });

    win.loadURL(url);
  });
}

module.exports = { promptMicrosoftLogin };
