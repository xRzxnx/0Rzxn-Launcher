'use strict';

const { app, BrowserWindow, Menu, protocol, shell } = require('electron');
const os = require('node:os');
const path = require('node:path');
const { journal, openJournal } = require('./core/journal');
const { registerIpc } = require('./ipc');

protocol.registerSchemesAsPrivileged([
  { scheme: 'skin', privileges: { standard: true, secure: true } },
  { scheme: 'fond', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const COLORS = {
  background: '#140c22',
  titlebar: '#00000000', // transparent : le décor passe sous les boutons de la fenêtre
  symbols: '#ffffff',
};

let mainWindow = null;

function createWindow() {
  const { lang, locale } = ipc.language();
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
      // La langue arrive avec la page : le premier rendu est déjà dans la bonne langue.
      additionalArguments: [`--ui-language=${lang}`, `--ui-locale=${locale}`],
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
  mainWindow.webContents.on('render-process-gone', (_event, details) => journal.error('Renderer process gone:', details));
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => journal.error(`Preload failed (${preloadPath}):`, error));

  // Les erreurs de l'interface vont dans le journal, et aussi dans le terminal en développement.
  mainWindow.webContents.on('console-message', ({ level, message, sourceId, lineNumber }) => {
    if (level !== 'warning' && level !== 'error') return;
    journal[level === 'error' ? 'error' : 'warn'](`[renderer] ${message} (${sourceId}:${lineNumber})`);
    if (!app.isPackaged) console.log(`[interface:${level}] ${message} (${sourceId}:${lineNumber})`);
  });

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

const NETTOYAGE_DELAI = 5 * 1000;

/** Après une installation manuelle : attend que la fenêtre soit ouverte pour ne pas ralentir le démarrage. */
function planifierNettoyage() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  setTimeout(() => {
    require('./core/anciennes-versions').apresInstallation({
      donnees: app.getPath('userData'),
      executable: process.execPath,
      produit: app.getName(),
      version: app.getVersion(),
      bureau: app.getPath('desktop'),
      shell,
    });
  }, NETTOYAGE_DELAI);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  openJournal({ dir: path.join(app.getPath('userData'), 'logs'), level: app.isPackaged ? 'info' : 'debug' });
  journal.info(`0Rzxn_ Launcher ${app.getVersion()}${app.isPackaged ? '' : ' (sources)'}, Electron ${process.versions.electron}, ${process.platform} ${os.release()} ${process.arch}`);
  // Erreurs non gérées : notées sans changer le comportement d'Electron (boîte d'erreur pour une exception,
  // simple avertissement dans la console pour une promesse rejetée, que l'on réécrit puisque l'écouteur le retire).
  process.on('uncaughtExceptionMonitor', (error, origin) => journal.error(`Uncaught exception (${origin}):`, error));
  process.on('unhandledRejection', (reason) => {
    journal.error('Unhandled promise rejection:', reason);
    console.warn('Unhandled promise rejection:', reason);
  });
  app.on('child-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') journal.warn('Child process gone:', details);
  });
  app.on('before-quit', () => journal.info('Quitting'));
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
    planifierNettoyage();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
