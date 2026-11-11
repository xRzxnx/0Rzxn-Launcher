'use strict';

// Pont entre l'interface et le cœur : chaque canal valide ses entrées avant d'agir.
// Les canaux sont rangés par domaine dans ce dossier ; l'orchestration vit dans ../services/.
const { resolveLanguage, setLanguage, t } = require('../i18n');
const { app, shell } = require('electron');
const { createServices } = require('../services/container');
const { LaunchManager } = require('../services/launches');
const { TaskManager } = require('../services/tasks');
const { createBackups } = require('../services/backups');
const { createContentService } = require('../services/content');
const { createShell } = require('../services/shell');
const { createHandle, launchArgument } = require('./handle');
const { journal } = require('../core/journal');
const { cleanTemporaryFiles } = require('../core/temp-files');

const CLEANUP_DELAY = 30 * 1000;

const DOMAINS = [
  require('./app'),
  require('./instances'),
  require('./content'),
  require('./modpacks'),
  require('./importer'),
  require('./crashes'),
  require('./worlds'),
  require('./accounts'),
  require('./launch'),
  require('./system'),
  require('./tasks'),
];

function registerIpc(getWindow) {
  const services = createServices();
  const { dirs, accounts, instances } = services;

  // Langue : le réglage du launcher, ou celle de Windows en automatique.
  let language;
  const applyLanguage = () => {
    language = resolveLanguage(services.settings.launcher().language, app.getPreferredSystemLanguages());
    setLanguage(language);
    return language;
  };
  applyLanguage();

  // File des tâches longues (page Activité) : deux à la fois, une par instance, rien sur une instance en cours de partie.
  const tasks = new TaskManager({ getWindow, history: services.db, inGame: (id) => launches.run?.instanceId === id });
  const launches = new LaunchManager(services, getWindow, tasks);
  const runTask = (label, work, options) => tasks.runLong(label, work, options);
  const trash = (file) => shell.trashItem(file);

  const ctx = {
    getWindow,
    handle: createHandle(getWindow),
    applyLanguage,
    services,
    dirs,
    accounts,
    instances,
    launches,
    tasks,
    runTask,
    trash,
    backups: createBackups({ dirs, instances, runTask, trash }),
    contents: createContentService({ instances, trash }),
    /** Rien ne touche une instance pendant sa partie. */
    notRunning(id, action) {
      if (launches.run?.instanceId === id) throw new Error(t('ipc.impossible_de_pendant_que_instance', { action }));
    },
    /** Ni partie ni tâche longue en cours. */
    notBusy(action) {
      if (launches.session) throw new Error(t('ipc.impossible_de_pendant_une_partie', { action }));
      const task = tasks.current();
      if (task) throw new Error(t('ipc.patiente_est_en_cours', { task }));
    },
    // Zone de notification, Discord et mises à jour : suivent la partie en cours.
    appShell: createShell({ getWindow, services, launches, isTaskBusy: () => tasks.busy() }),
  };
  for (const domain of DOMAINS) domain.register(ctx);

  // Fichiers temporaires abandonnés : retirés en tâche de fond, un peu après l'ouverture.
  const cleanup = setTimeout(() => {
    tasks
      .run({ kind: 'temp-cleanup', label: t('ipc.nettoyage_des_fichiers_temporaires'), priority: 'low', hidden: true, work: ({ signal }) => cleanTemporaryFiles({ dirs, signal }) })
      .then(({ count, bytes }) => count && journal.info(`Temporary files removed: ${count} (${bytes} bytes)`))
      .catch((error) => journal.warn('Temporary files cleanup failed:', error));
  }, CLEANUP_DELAY);
  cleanup.unref?.();

  return {
    /** La fenêtre réapparaît (mode léger) : les logs en attente sont envoyés. */
    windowShown() {
      launches.resume();
    },
    language: () => language,
    /** Le launcher est déjà ouvert et un raccourci a été lancé : on transmet la demande. */
    handleArgv(argv) {
      const id = launchArgument(argv);
      const win = getWindow();
      if (id && win && !win.isDestroyed()) win.webContents.send('app:launchRequest', id);
    },
    hideOnClose: () => ctx.appShell.hideOnClose(),
    beforeQuit() {
      clearTimeout(cleanup);
      ctx.appShell.beforeQuit();
      services.db.close();
    },
  };
}

module.exports = { registerIpc };
