'use strict';

// Pont entre l'interface et le cœur : chaque canal valide ses entrées avant d'agir.
// Les canaux sont rangés par domaine dans ce dossier ; l'orchestration vit dans ../services/.
const { resolveLanguage, setLanguage, t } = require('../i18n');
const { app, shell } = require('electron');
const { createServices } = require('../services/container');
const { LaunchManager } = require('../services/launches');
const { createTaskRunner } = require('../services/tasks');
const { createBackups } = require('../services/backups');
const { createContentService } = require('../services/content');
const { createShell } = require('../services/shell');
const { createHandle, launchArgument } = require('./handle');

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

  const launches = new LaunchManager(services, getWindow);
  const tasks = createTaskRunner(getWindow);
  const runTask = tasks.run;
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
    appShell: createShell({ getWindow, services, launches, isTaskBusy: () => Boolean(tasks.current()) }),
  };
  for (const domain of DOMAINS) domain.register(ctx);

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
      ctx.appShell.beforeQuit();
      services.db.close();
    },
  };
}

module.exports = { registerIpc };
