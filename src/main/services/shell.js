'use strict';

// Ce qui entoure la fenêtre : zone de notification, Quitter, statut Discord et mises à jour du launcher.
const { t } = require('../i18n');
const { app, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { DiscordPresence, gameActivity } = require('../core/discord');
const { UpdateManager } = require('../core/updates');
const discordConfig = require('../discord-config');
const { LauncherTray } = require('../tray');
const platform = require('../platform');

const LOADER_NAMES = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };

/** Journal des mises à jour : un fichier par session, pour comprendre un échec chez un utilisateur. */
function updateLog(file) {
  fs.rmSync(file, { force: true });
  const write = (level) => (message) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${message}\n`);
    } catch {
      // le journal ne doit jamais gêner la mise à jour
    }
  };
  return { info: write('info'), warn: write('warn'), error: write('error') };
}

/** `isTaskBusy()` : une tâche longue est en cours (services/tasks.js). */
/** `openWindow()` : ouvre la fenêtre, ou la recrée si elle a été fermée pendant une partie. */
function createShell({ getWindow, services, launches, isTaskBusy, openWindow = null }) {
  const { accounts, instances } = services;
  let quitting = false;
  let balloonShown = false;
  const requestLaunch = (id) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    tray.showWindow();
    win.webContents.send('app:launchRequest', id);
  };
  const quit = async () => {
    if (launches.run) {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: t('ipc.quitter_0rzxn_launcher'),
        message: t('ipc.une_partie_est_en_cours'),
        detail: t('ipc.le_temps_de_jeu_de'),
        buttons: [t('common.annuler'), t('common.quitter')],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) return;
    }
    quitting = true;
    app.quit();
  };
  const tray = new LauncherTray({ getWindow, openWindow, instances, launches, canPlay: () => Boolean(accounts.list().activeId), onLaunch: requestLaunch, onQuit: quit });

  // Discord : rien n'est envoyé tant que l'option est désactivée ; le statut suit la partie en cours.
  const presence = new DiscordPresence({ clientId: discordConfig.clientId, pipe: discordConfig.pipe });
  const countMods = (instance) => {
    if (instance.loader === 'vanilla') return 0;
    try {
      return fs.readdirSync(path.join(instances.gameDir(instance.id), 'mods')).filter((f) => f.endsWith('.jar')).length;
    } catch {
      return 0;
    }
  };
  const syncDiscord = async () => {
    const prefs = services.settings.launcher();
    const run = launches.run;
    if (!discordConfig.clientId || !prefs.discord || run?.phase !== 'running') {
      await presence.close();
      return;
    }
    const instance = instances.get(run.instanceId);
    await presence.setActivity(
      gameActivity({ instance, loaderName: LOADER_NAMES[instance.loader], mods: countMods(instance), startedAt: run.startedAt, showName: prefs.discordShowName }),
    );
  };
  let discordQueue = Promise.resolve();
  const queueDiscord = () => {
    discordQueue = discordQueue.then(syncDiscord).catch((error) => {
      if (!app.isPackaged) console.log(`[discord] ${error.message}`);
    });
    return discordQueue;
  };
  launches.onChange = () => {
    tray.refresh();
    queueDiscord();
    updates.gameChanged();
  };
  tray.setEnabled(services.settings.launcher().tray);
  // Linux : l'icône créée n'apparaît pas si le bureau n'a pas de zone de notification ; on la retire alors.
  platform.trayAvailable().then((available) => {
    if (!available) tray.setAvailable(false);
  });

  // Mises à jour du launcher : seulement dans la version installée, et jamais pendant une partie.
  const updates = new UpdateManager({
    supported: app.isPackaged,
    loadUpdater: () => require('electron-updater').autoUpdater,
    isBusy: () => Boolean(launches.session || isTaskBusy()),
    isAutomatic: () => services.settings.launcher().autoUpdate,
    channel: () => services.settings.launcher().updateChannel,
    onState: (status) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('update:status', status);
    },
    log: app.isPackaged ? updateLog(path.join(app.getPath('userData'), 'mises-a-jour.log')) : null,
  });
  updates.start();

  return {
    tray,
    presence,
    updates,
    queueDiscord,
    async discordStatus() {
      return {
        configured: Boolean(discordConfig.clientId),
        running: await presence.isRunning(),
        showing: Boolean(presence.socket && presence.activity),
      };
    },
    /** Fermer la fenêtre la cache seulement si l'icône de la zone de notification permet de la rouvrir. */
    hideOnClose() {
      const prefs = services.settings.launcher();
      if (quitting || !tray.enabled || !prefs.closeToTray) return false;
      if (!balloonShown && process.platform === 'win32') {
        balloonShown = true;
        tray.tray.displayBalloon({ iconType: 'info', title: '0Rzxn_ Launcher', content: t('ipc.le_launcher_reste_ouvert_ici') });
      }
      return true;
    },
    beforeQuit() {
      quitting = true;
      tray.setEnabled(false);
      presence.close();
      updates.stop();
    },
  };
}

module.exports = { createShell };
