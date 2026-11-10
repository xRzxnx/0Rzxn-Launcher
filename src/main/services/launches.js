'use strict';

// Partie en cours : préparation, lancement, logs envoyés à l'interface, fin de partie et plantage.
const { t } = require('../i18n');
const { app } = require('electron');
const fs = require('node:fs');
const { LaunchSession, quickPlayFile } = require('../core/launch');
const crashes = require('../core/crashes');
const { gpu } = require('../platform');
const worlds = require('../core/worlds');

const LOG_BUFFER = 5000;
const BYTE_FIELDS = ['doneBytes', 'totalBytes', 'speed', 'eta'];
const text = (value) => (typeof value === 'string' ? value : '');

/** Une seule partie (ou préparation) à la fois, comme dans l'interface. */
class LaunchManager {
  constructor(services, getWindow) {
    this.services = services;
    this.getWindow = getWindow;
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
    session.on('failed', ({ message, cancelled }) => {
      history?.endSession(sessionId, { outcome: cancelled ? 'cancelled' : 'failed' });
      this.finish({ error: cancelled ? null : message, cancelled });
    });
    session.on('running', () => {
      history?.sessionReady(sessionId);
      this.run.phase = 'running';
      this.run.startedAt = Date.now();
      this.status();
      const win = this.getWindow();
      // Mode léger : les minuteurs de l'interface ralentissent quand la fenêtre est cachée.
      if (win && this.services.settings.launcher().lightMode) win.webContents.setBackgroundThrottling(true);
      if (win && instance.settings.afterLaunch === 'minimize') win.minimize();
      if (win && instance.settings.afterLaunch === 'hide') win.hide();
    });
    session.on('exit', async ({ code, crashed, minutes }) => {
      history?.endSession(sessionId, { outcome: crashed ? 'crashed' : 'exited', exitCode: code ?? null });
      instances.recordPlay(instanceId, minutes);
      this.keepQuickPlay(instanceId);
      const win = this.getWindow();
      if (win && !win.isDestroyed() && (!win.isVisible() || win.isMinimized())) {
        win.show();
        win.restore();
        win.focus();
      }
      const since = this.run?.startedAt ?? Date.now() - (minutes + 1) * 60000;
      const crash = crashed ? await this.keepCrash(instanceId, since, code).catch(() => null) : null;
      this.finish({ exited: true, code, crashed, crash });
    });

    session.start();
    return this.run;
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
    if (!gpu.supported || !this.services.settings.launcher().gpuHighPerformance) return;
    if ((await gpu.preference(exe)) === 'high') return;
    await gpu.setHighPerformance([exe]);
    log(t('ipc.carte_graphique_dediee_choisie_pour'));
  }

  finish(extra) {
    this.session = null;
    this.pausedNow = false;
    const win = this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.setBackgroundThrottling(false);
    const instanceId = this.run?.instanceId;
    this.run = null;
    // Les derniers logs (et ceux gardés par le mode léger) partent avant le changement d'état.
    clearTimeout(this.flushTimer);
    this.flushLogs();
    this.status({ ...extra, instanceId });
  }

  stop() {
    this.session?.stop();
  }

  state() {
    return { run: this.run, logs: this.logs };
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
