'use strict';

// Mises à jour du launcher : recherche sur GitHub, téléchargement en arrière-plan et installation.
// Rien ne commence pendant une partie, et une erreur de recherche automatique reste silencieuse.
const { t } = require('../i18n');

const FIRST_CHECK_DELAY = 8 * 1000;
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

/**
 * États : idle (rien de connu) | checking | current (à jour) | waiting (version trouvée, le jeu tourne)
 * | downloading | ready (installable) | error (seulement après une recherche demandée).
 */
class UpdateManager {
  /**
   * @param {object} options
   * @param {boolean} options.supported faux hors du launcher installé
   * @param {() => object} options.loadUpdater charge electron-updater à la première recherche
   * @param {() => boolean} options.isBusy partie, lancement ou installation en cours
   * @param {() => boolean} options.isAutomatic réglage « rechercher automatiquement »
   * @param {(state: object) => void} options.onState reçoit chaque changement d'état
   * @param {object} [options.log] info, warn, error
   */
  constructor({ supported, loadUpdater, isBusy, isAutomatic, onState, log = null, now = Date.now, timers = { setTimeout, clearTimeout, setInterval, clearInterval } }) {
    Object.assign(this, { loadUpdater, isBusy, isAutomatic, onState, log, now, timers });
    this.state = { supported, status: 'idle', version: null, percent: 0, transferred: 0, total: 0, checkedAt: null, error: null };
    this.updater = null;
    this.available = false;
    this.manual = false;
    this.first = null;
    this.interval = null;
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.onState({ ...this.state });
  }

  /** Une erreur demandée s'affiche ; une erreur automatique ne change rien à l'écran et attend la prochaine recherche. */
  fail(error, fallback) {
    const message = String(error?.message ?? error);
    this.log?.warn(message);
    this.available = false;
    if (this.manual) this.set({ status: 'error', error: friendlyError(message) });
    else this.set({ status: fallback, error: null });
    this.manual = false;
  }

  updaterInstance() {
    if (this.updater) return this.updater;
    const updater = this.loadUpdater();
    updater.autoDownload = false; // le téléchargement attend la fin de la partie
    updater.autoInstallOnAppQuit = true;
    updater.disableWebInstaller = true; // l'installateur complet est le seul publié
    updater.logger = this.log;
    updater.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent), transferred: p.transferred, total: p.total }));
    updater.on('update-downloaded', (info) => {
      this.available = false;
      this.manual = false;
      this.set({ status: 'ready', version: info.version, percent: 100, error: null });
    });
    this.updater = updater;
    return updater;
  }

  start() {
    if (!this.state.supported || this.first) return;
    const tick = () => {
      if (this.isAutomatic()) this.check().catch(() => {});
    };
    this.first = this.timers.setTimeout(tick, FIRST_CHECK_DELAY);
    this.interval = this.timers.setInterval(tick, CHECK_INTERVAL);
  }

  stop() {
    this.timers.clearTimeout(this.first);
    this.timers.clearInterval(this.interval);
  }

  /** Une seule recherche à la fois ; une version déjà prête n'est pas remise en cause. */
  async check({ manual = false } = {}) {
    if (!this.state.supported) return { ...this.state };
    const { status } = this.state;
    if (status === 'checking' || status === 'downloading' || status === 'ready') return { ...this.state };
    if (status === 'waiting') {
      this.manual = this.manual || manual;
      this.gameChanged(); // une installation de jeu terminée ne prévient pas : on revérifie ici
      return { ...this.state };
    }
    this.manual = manual;
    this.set({ status: 'checking', error: null });
    try {
      const result = await this.updaterInstance().checkForUpdates();
      const checkedAt = this.now();
      if (!result?.isUpdateAvailable) {
        this.manual = false;
        this.set({ status: 'current', version: null, checkedAt });
        return { ...this.state };
      }
      this.available = true;
      this.set({ version: result.updateInfo.version, checkedAt });
      await this.download();
    } catch (error) {
      this.fail(error, 'idle');
    }
    return { ...this.state };
  }

  async download() {
    if (!this.available) return;
    if (this.isBusy()) {
      this.set({ status: 'waiting' });
      return;
    }
    this.set({ status: 'downloading', percent: 0, transferred: 0, total: 0 });
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      this.fail(error, 'idle');
    }
  }

  /** À appeler quand une partie change d'état : le téléchargement en attente démarre après le jeu. */
  gameChanged() {
    if (this.state.status === 'waiting' && !this.isBusy()) this.download();
  }

  /** Installe sans fenêtre et rouvre le launcher. */
  install() {
    if (this.state.status !== 'ready') throw new Error(t('update.none_ready'));
    if (this.isBusy()) throw new Error(t('update.close_game'));
    this.updater.quitAndInstall(true, true);
  }
}

function friendlyError(message) {
  if (/ERR_INTERNET|ENOTFOUND|ETIMEDOUT|ECONNRE|net::|getaddrinfo|socket hang up/i.test(message)) return t('update.err_network');
  if (/sha512|checksum/i.test(message)) return t('update.err_incomplete');
  return t('update.err_failed');
}

module.exports = { UpdateManager, FIRST_CHECK_DELAY, CHECK_INTERVAL };
