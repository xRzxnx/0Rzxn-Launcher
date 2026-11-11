'use strict';

// Partie en cours : préparation, lancement, logs envoyés à l'interface, fin de partie et plantage.
const { t, num } = require('../i18n');
const { app } = require('electron');
const fs = require('node:fs');
const { LaunchSession, quickPlayFile } = require('../core/launch');
const crashes = require('../core/crashes');
const os = require('node:os');
const platform = require('../platform');
const worlds = require('../core/worlds');

const LOG_BUFFER = 5000;
// Mesures du jeu : toutes les 2 s fenêtre ouverte ; pic relu chaque minute fenêtre fermée ; pic écrit au plus toutes les 30 s.
const METRICS_INTERVAL = 2000;
const PEAK_INTERVAL = 60 * 1000;
const PEAK_SAVE_INTERVAL = 30 * 1000;
// Menu du jeu atteint : cette ligne apparaît quand le son démarre, juste avant l'écran titre.
const MENU_LINE = /Sound engine started/;
const BYTE_FIELDS = ['doneBytes', 'totalBytes', 'speed', 'eta'];
const text = (value) => (typeof value === 'string' ? value : '');

/** Une seule partie (ou préparation) à la fois, comme dans l'interface. */
class LaunchManager {
  /**
   * `tasks` : la préparation apparaît dans la page Activité (tâche « launch-prepare »).
   * `windowControl` : { open, close } de main.js, pour fermer l'interface pendant la partie (réglage « Masquer »).
   */
  constructor(services, getWindow, tasks = null, windowControl = null) {
    this.services = services;
    this.getWindow = getWindow;
    this.tasks = tasks;
    this.windowControl = windowControl;
    this.canCloseWindow = () => false;
    this.windowClosed = false; // fenêtre fermée exprès pendant la partie
    this.reopened = false; // fenêtre recréée : elle revient sur l'écran noté dans `view`
    this.view = null;
    this.pendingEnd = null; // fin de partie arrivée sans fenêtre : remise à l'interface rouverte (launch:state)
    this.metrics = null; // { instanceId, memory, peak, cpu, allocated } du jeu en cours
    this.processMetrics = platform.processMetrics;
    this.cpus = os.cpus().length || 1;
    this.session = null;
    this.run = null; // { instanceId, phase, step, done, total, prepareOnly }
    this.logs = [];
    this.pendingLogs = [];
    this.flushTimer = null;
    this.onChange = null; // la zone de notification et Discord suivent la partie
  }

  send(channel, payload) {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  /** Mode léger : pendant la partie, fenêtre réduite ou masquée, les logs attendent que la fenêtre revienne. */
  paused() {
    if (this.run?.phase !== 'running' || !this.services.settings.launcher().lightMode) return false;
    const win = this.getWindow();
    return !win || win.isDestroyed() || !win.isVisible() || win.isMinimized();
  }

  pushLog(line) {
    this.logs.push(line);
    if (this.logs.length > LOG_BUFFER) this.logs.splice(0, this.logs.length - LOG_BUFFER);
    this.pendingLogs.push(line);
    // Trop de lignes en attente : l'interface recevra tout le tampon d'un coup.
    if (this.pendingLogs.length > LOG_BUFFER) {
      this.pendingLogs.splice(0, this.pendingLogs.length - LOG_BUFFER);
      this.resync = true;
    }
    if (!this.flushTimer && !this.pausedNow) this.flushTimer = setTimeout(() => this.flushLogs(), 100);
    if (!this.menuAt && this.readyAt && MENU_LINE.test(line.msg ?? '')) this.menuReached();
  }

  flushLogs() {
    this.flushTimer = null;
    // Réglage relu une fois par paquet de logs, pas à chaque ligne.
    this.pausedNow = this.paused();
    if (this.pausedNow || !this.pendingLogs.length) return;
    if (this.resync) {
      this.resync = false;
      this.pendingLogs = [];
      this.send('launch:reset');
      this.send('launch:logs', this.logs.slice());
      return;
    }
    this.send('launch:logs', this.pendingLogs.splice(0));
  }

  /** La fenêtre réapparaît : les logs en attente partent tout de suite. */
  resume() {
    this.pausedNow = false;
    if (this.pendingLogs.length && !this.flushTimer) this.flushTimer = setTimeout(() => this.flushLogs(), 0);
  }

  status(extra = {}) {
    this.send('launch:status', { run: this.run, ...extra });
    this.onChange?.();
  }

  start(instanceId, { verify = false, prepareOnly = false, quickPlay = null } = {}) {
    if (this.session) throw new Error(t('ipc.une_partie_ou_une_installation'));
    const { dirs, instances, accounts } = this.services;
    const instance = instances.get(instanceId);
    const accountId = accounts.resolveId(instance.accountId);
    if (!accountId) throw new Error(t('common.ajoute_un_compte_avant_de'));
    // Une tâche longue (sauvegarde, mise à jour…) touche cette instance : la partie attend qu'elle finisse.
    const busy = this.tasks?.runningOn(instanceId);
    if (busy) throw new Error(t('ipc.patiente_est_en_cours', { task: busy.label }));

    const session = new LaunchSession({
      dirs,
      instance,
      instanceDir: instances.dir(instanceId),
      getAccount: (log) => {
        if (instance.accountId && instance.accountId !== accountId) log(t('ipc.le_compte_choisi_pour_cette'));
        return accounts.launchAccount(log, accountId);
      },
      launcherVersion: app.getVersion(),
      verify,
      prepareOnly,
      prepareJava: (exe, log) => this.prepareJava(exe, log),
      quickPlay,
    });
    this.session = session;
    this.logs = [];
    this.pendingLogs = [];
    this.pausedNow = false;
    this.resync = false;
    this.run = { instanceId, phase: 'preparing', step: 0, done: 0, total: 0, prepareOnly };
    this.send('launch:reset');
    this.status();

    // Historique dans launcher.db (sans effet si la base est absente).
    const history = this.services.db;
    const sessionId = history?.startSession({ instanceId, version: instance.version, loader: instance.loader }) ?? null;

    session.on('log', (line) => this.pushLog(line));
    session.on('progress', ({ step, done, total, ...bytes }) => {
      Object.assign(this.run, { step, done, total });
      // Octets, vitesse et temps restant du téléchargement en cours (pas encore affichés) ; retirés hors téléchargement.
      for (const key of BYTE_FIELDS) {
        if (bytes[key] != null) this.run[key] = bytes[key];
        else delete this.run[key];
      }
      this.send('launch:progress', this.run);
    });
    session.on('loaderInstalled', ({ versionId }) => instances.markLoaderInstalled(instanceId, versionId));
    session.on('prepared', () => {
      history?.endSession(sessionId, { outcome: 'prepared' });
      this.finish({ prepared: true });
    });
    session.on('failed', ({ message, cancelled, code = null }) => {
      history?.endSession(sessionId, { outcome: cancelled ? 'cancelled' : 'failed' });
      this.finish({ error: cancelled ? null : message, cancelled, ...(code ? { errorCode: code } : {}) });
    });
    this.sessionId = sessionId;
    this.launchedAt = Date.now();
    this.readyAt = null;
    this.menuAt = null;
    this.stopMetrics();
    this.metrics = null;
    session.on('running', ({ pid } = {}) => {
      history?.sessionReady(sessionId);
      this.run.phase = 'running';
      this.run.startedAt = Date.now();
      this.readyAt = this.run.startedAt;
      this.run.prepareMs = this.readyAt - this.launchedAt;
      this.startMetrics(pid, instance);
      this.status();
      const win = this.getWindow();
      // Mode léger : les minuteurs de l'interface ralentissent quand la fenêtre est cachée.
      if (win && this.services.settings.launcher().lightMode) win.webContents.setBackgroundThrottling(true);
      if (win && instance.settings.afterLaunch === 'minimize') win.minimize();
      if (win && instance.settings.afterLaunch === 'hide') this.hideWindow(win);
    });
    session.on('exit', async ({ code, crashed, minutes }) => {
      this.stopMetrics({ save: true });
      history?.endSession(sessionId, { outcome: crashed ? 'crashed' : 'exited', exitCode: code ?? null });
      instances.recordPlay(instanceId, minutes);
      this.keepQuickPlay(instanceId);
      const win = this.getWindow();
      const closed = this.windowClosed;
      if (closed) this.windowControl?.open();
      else if (win && !win.isDestroyed() && (!win.isVisible() || win.isMinimized())) {
        win.show();
        win.restore();
        win.focus();
      }
      const since = this.run?.startedAt ?? Date.now() - (minutes + 1) * 60000;
      const crash = crashed ? await this.keepCrash(instanceId, since, code).catch(() => null) : null;
      this.finish({ exited: true, code, crashed, crash }, closed);
    });

    this.trackPreparation(session, instance, prepareOnly);
    session.start();
    return this.run;
  }

  /**
   * Préparation visible dans la page Activité : finie quand le jeu démarre ou que les fichiers sont prêts (elle ne
   * peut donc plus être annulée depuis la page une fois le jeu lancé). Annuler la tâche arrête la préparation.
   */
  trackPreparation(session, instance, prepareOnly) {
    if (!this.tasks) return;
    let report = null;
    const ended = new Promise((resolve, reject) => {
      session.once('running', resolve);
      session.once('prepared', resolve);
      session.once('exit', resolve);
      session.once('failed', ({ message, cancelled }) => reject(Object.assign(new Error(message ?? ''), { cancelled: Boolean(cancelled) })));
    });
    session.on('progress', ({ step, done, total, ...bytes }) => report?.({ step, done, total, ...bytes }));
    this.tasks
      .run({
        kind: 'launch-prepare',
        label: prepareOnly ? t('ipc.verification_de', { name: instance.name }) : t('ipc.preparation_de_la_partie', { name: instance.name }),
        instanceId: instance.id,
        immediate: true,
        cancellable: true,
        params: { name: instance.name, prepareOnly },
        work: ({ signal, progress }) => {
          report = progress;
          signal.addEventListener('abort', () => session.stop(), { once: true });
          return ended;
        },
      })
      .catch(() => {}); // l'échec est déjà montré par l'accueil (launch:status)
  }

  /** Rapport du plantage : celui écrit par le jeu ou par Java, sinon les logs de la partie, gardés par le launcher. */
  async keepCrash(instanceId, since, code) {
    const { instances } = this.services;
    const dirs = { gameDir: instances.gameDir(instanceId), instanceDir: instances.dir(instanceId) };
    const report = (await crashes.listCrashes(dirs)).find((c) => c.source !== 'log' && c.at >= since - 5000);
    if (report) return { source: report.source, file: report.file };
    return { source: 'log', file: await crashes.saveCrashLog(dirs.instanceDir, this.logs, { code }) };
  }

  /** Monde ou serveur rejoint pendant la partie, noté par le jeu (1.20 et plus) : il rejoint la liste « Reprendre ». */
  keepQuickPlay(instanceId) {
    const { instances } = this.services;
    const file = quickPlayFile(instances.dir(instanceId));
    try {
      const [entry] = [].concat(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (entry?.type && entry.id) instances.recordQuickPlay(instanceId, { type: entry.type, id: String(entry.id), name: String(entry.name ?? entry.id) });
    } catch {
      // pas de fichier : aucune partie rejointe, ou version d'avant 1.20
    }
    fs.rmSync(file, { force: true });
  }

  /** Accord donné pour la carte dédiée : chaque nouveau java.exe la reçoit aussi. */
  async prepareJava(exe, log) {
    const { gpu } = platform;
    if (!gpu.supported || !this.services.settings.launcher().gpuHighPerformance) return;
    if ((await gpu.preference(exe)) === 'high') return;
    await gpu.setHighPerformance([exe]);
    log(t('ipc.carte_graphique_dediee_choisie_pour'));
  }

  /**
   * « Masquer » après le lancement : avec le mode léger et l'icône près de l'horloge, la fenêtre est fermée pour de vrai
   * (le processus de l'interface s'arrête) ; sans icône pour la rouvrir, elle est seulement réduite.
   */
  hideWindow(win) {
    if (!this.services.settings.launcher().lightMode) {
      win.hide();
      return;
    }
    if (!this.windowControl || !this.canCloseWindow()) {
      win.minimize();
      return;
    }
    this.windowClosed = true;
    this.windowControl.close();
    this.watchMetrics(); // plus de mesures fines : seulement le pic de mémoire
  }

  /** Menu du jeu atteint : noté avec la partie et signalé dans la console par une ligne du launcher. */
  menuReached() {
    this.menuAt = Date.now();
    this.services.db?.sessionMenu(this.sessionId, this.menuAt);
    const seconds = (ms) => num(ms / 1000, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
    const line = {
      time: new Date(this.menuAt).toTimeString().slice(0, 8),
      tag: 'LAUNCHER',
      mark: true,
      msg: t('launch.menu_atteint', { game: seconds(this.menuAt - this.readyAt), total: seconds(this.menuAt - this.launchedAt) }),
    };
    this.logs.push(line);
    this.pendingLogs.push(line);
    if (this.run) {
      this.run.menuMs = this.menuAt - this.readyAt;
      this.send('launch:progress', this.run);
    }
  }

  /**
   * Mesures du jeu pendant la partie. Fenêtre ouverte : mémoire et processeur toutes les 2 s (launch:metrics) ;
   * fenêtre fermée : seul le pic de mémoire, relu chaque minute.
   */
  startMetrics(pid, instance) {
    if (!this.processMetrics?.supported || !pid) return;
    this.pid = pid;
    this.metrics = { instanceId: instance.id, memory: null, peak: null, cpu: null, allocated: instance.settings.ram * 1024 ** 3 };
    this.peakSavedAt = 0;
    this.watchMetrics();
  }

  /** Mesures fines si une fenêtre est là, sinon relevé du pic seulement. */
  watchMetrics() {
    clearInterval(this.peakTimer);
    this.metricsWatch?.stop();
    this.metricsWatch = null;
    this.cpuPrev = null;
    if (!this.pid || !this.metrics) return;
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      this.metricsWatch = this.processMetrics.watch(this.pid, { intervalMs: METRICS_INTERVAL, onSample: (sample) => this.onSample(sample) });
    } else {
      this.peakTimer = setInterval(() => {
        this.processMetrics.peak(this.pid).then((peak) => peak && this.notePeak(peak), () => {});
      }, PEAK_INTERVAL);
      this.peakTimer.unref?.();
    }
  }

  onSample({ memory, peak, cpuMs }) {
    if (!this.metrics) return;
    const now = Date.now();
    const prev = this.cpuPrev;
    this.cpuPrev = { at: now, cpuMs };
    const cpu = prev && now > prev.at ? Math.max(0, Math.min(100, ((cpuMs - prev.cpuMs) / ((now - prev.at) * this.cpus)) * 100)) : null;
    Object.assign(this.metrics, { memory, cpu: cpu == null ? this.metrics.cpu : Math.round(cpu) });
    this.notePeak(peak);
    if (!this.paused()) this.send('launch:metrics', this.metrics);
  }

  notePeak(peak) {
    if (!this.metrics || !(peak > (this.metrics.peak ?? 0))) return;
    this.metrics.peak = peak;
    if (Date.now() - this.peakSavedAt >= PEAK_SAVE_INTERVAL) {
      this.peakSavedAt = Date.now();
      this.services.db?.sessionPeak(this.sessionId, peak);
    }
  }

  /** Fin de la partie : plus de mesures ; `save` écrit le dernier pic connu. */
  stopMetrics({ save = false } = {}) {
    clearInterval(this.peakTimer);
    this.peakTimer = null;
    this.metricsWatch?.stop();
    this.metricsWatch = null;
    if (save && this.metrics?.peak) this.services.db?.sessionPeak(this.sessionId, this.metrics.peak);
    this.pid = null;
  }

  /** Nouvelle fenêtre : elle lit tous les logs par launch:state, ceux gardés pour l'ancienne ne servent plus. */
  windowCreated() {
    this.windowClosed = false;
    this.reopened = true;
    this.pendingLogs = [];
    this.resync = false;
    this.pausedNow = false;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.pid) this.watchMetrics();
  }

  /** Écran où rouvrir la fenêtre recréée (une seule fois). */
  takeReopenView() {
    if (!this.reopened) return null;
    this.reopened = false;
    return this.view;
  }

  /** @param {object} extra @param {boolean} [noWindow] la fenêtre était fermée : la fin est gardée pour l'interface rouverte */
  finish(extra, noWindow = false) {
    this.session = null;
    this.stopMetrics();
    this.metrics = null;
    this.pausedNow = false;
    const win = this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.setBackgroundThrottling(false);
    const instanceId = this.run?.instanceId;
    this.run = null;
    // Les tâches qui attendaient la fin de la partie sur cette instance peuvent démarrer.
    this.tasks?.pump();
    // Les derniers logs (et ceux gardés par le mode léger) partent avant le changement d'état.
    clearTimeout(this.flushTimer);
    this.flushLogs();
    if (noWindow) this.pendingEnd = { ...extra, instanceId };
    this.status({ ...extra, instanceId });
  }

  stop() {
    this.session?.stop();
  }

  /** État pour une interface qui s'ouvre ; `ended` : fin de partie arrivée sans fenêtre, remise une seule fois. */
  state() {
    const ended = this.pendingEnd;
    this.pendingEnd = null;
    const metrics = this.run?.phase === 'running' ? this.metrics : null;
    return { run: this.run, logs: this.logs, ...(metrics ? { metrics } : {}), ...(ended ? { ended } : {}) };
  }
}

/** Monde ou serveur demandé par l'interface : un monde doit exister dans l'instance, une adresse rester une adresse. */
function quickPlayTarget(instances, id, target) {
  if (!target || (target.type !== 'singleplayer' && target.type !== 'multiplayer')) return null;
  const name = text(target.name).slice(0, 100);
  if (target.type === 'singleplayer') {
    worlds.worldDir(instances.gameDir(id), text(target.id)); // lève une erreur si le monde n'existe plus
    return { type: 'singleplayer', id: text(target.id), name };
  }
  const address = text(target.id).trim();
  if (!/^[\w.\-:[\]]{1,255}$/.test(address)) throw new Error(t('ipc.adresse_de_serveur_invalide'));
  return { type: 'multiplayer', id: address, name };
}

module.exports = { LaunchManager, quickPlayTarget };
