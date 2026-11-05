'use strict';

const { app, BrowserWindow, Menu, protocol, shell } = require('electron');
const path = require('node:path');
const { registerIpc } = require('./ipc');

// Captures d'écran affichées dans l'interface (servies par ipc.js, dossier screenshots uniquement).
protocol.registerSchemesAsPrivileged([
  { scheme: 'shot', privileges: { standard: true, secure: true } },
  { scheme: 'skin', privileges: { standard: true, secure: true } },
]);

const COLORS = {
  background: '#0d0f1a',
  titlebar: '#0a0c15',
  symbols: '#a3a7c2',
};

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 680,
    title: '0Rzxn_ Launcher',
    backgroundColor: COLORS.background,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: COLORS.titlebar, symbolColor: COLORS.symbols, height: 34 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Les logs du jeu doivent continuer d'arriver quand le launcher est réduit.
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Pas de show: false + ready-to-show : Chromium met ~300 ms à peindre sa première image, la fenêtre
  // (déjà au bon fond sombre) apparaît sans l'attendre.

  // Les liens externes s'ouvrent dans le navigateur, jamais dans le launcher.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  // En développement, les erreurs de l'interface s'affichent aussi dans le terminal.
  if (!app.isPackaged) {
    mainWindow.webContents.on('console-message', ({ level, message, sourceId, lineNumber }) => {
      if (level === 'warning' || level === 'error') console.log(`[interface:${level}] ${message} (${sourceId}:${lineNumber})`);
    });
  }

  // Option « Fermer la fenêtre garde le launcher ouvert » : la fenêtre se cache dans la zone de notification.
  mainWindow.on('close', (event) => {
    if (ipc?.hideOnClose()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  // Mode léger : les logs gardés pendant que la fenêtre était cachée arrivent dès qu'elle revient.
  for (const event of ['show', 'restore']) mainWindow.on(event, () => ipc?.windowShown());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

let ipc = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('before-quit', () => ipc?.beforeQuit());
  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    ipc?.handleArgv(argv);
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    ipc = registerIpc(() => mainWindow);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
