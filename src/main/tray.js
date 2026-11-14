'use strict';

// Icône dans la zone de notification : clic = afficher ou masquer le launcher,
// clic droit = partie en cours, instances récentes et Quitter.
const { t } = require('./i18n');
const path = require('node:path');
const { Menu, Tray, dialog, nativeImage } = require('electron');

const RECENT = 5;

/**
 * Icône de la zone de notification (tray.png et tray@2x.png), avec une pastille pendant une partie.
 * macOS : version « Template » noire sur fond transparent, que le système colore selon la barre de menus claire ou sombre.
 */
function trayIcon(playing, platform = process.platform) {
  const name = (playing ? 'tray-playing' : 'tray') + (platform === 'darwin' ? 'Template' : '');
  return nativeImage.createFromPath(path.join(__dirname, 'assets', `${name}.png`));
}

const minutesSince = (at) => Math.max(0, Math.round((Date.now() - at) / 60000));

/**
 * `ctx` : getWindow, openWindow() (recrée la fenêtre fermée pendant une partie), instances (InstanceStore),
 * launches (LaunchManager), canPlay(), onLaunch(id), onQuit().
 * L'icône suit la partie en cours grâce à `refresh()`, appelé à chaque changement d'état.
 */
class LauncherTray {
  constructor(ctx) {
    this.ctx = ctx;
    this.tray = null;
    this.playing = null;
    // Faux sous Linux quand le bureau n'affiche pas les icônes de notification (GNOME sans extension AppIndicator).
    this.available = true;
  }

  get enabled() {
    return Boolean(this.tray);
  }

  /** Bureau sans zone de notification : l'icône est retirée et ne revient plus (« Garder en arrière-plan » non plus). */
  setAvailable(available) {
    this.available = available;
    if (!available) this.setEnabled(false);
  }

  setEnabled(on) {
    if (on && !this.tray && this.available) {
      this.tray = new Tray(trayIcon(false));
      this.playing = false;
      this.tray.on('click', () => this.toggleWindow());
      this.tray.on('right-click', () => this.tray.popUpContextMenu(this.menu()));
      this.refresh();
    } else if (!on && this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  toggleWindow() {
    const win = this.ctx.getWindow();
    if (!win || win.isDestroyed()) {
      this.showWindow();
      return;
    }
    if (win.isVisible() && !win.isMinimized() && win.isFocused()) win.hide();
    else this.showWindow();
  }

  showWindow() {
    const win = this.ctx.getWindow();
    if (!win || win.isDestroyed()) {
      this.ctx.openWindow?.();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  current() {
    const run = this.ctx.launches.run;
    if (!run) return null;
    let instance = null;
    try {
      instance = this.ctx.instances.get(run.instanceId);
    } catch {
      // instance supprimée entre-temps
    }
    return { run, instance };
  }

  refresh() {
    if (!this.tray) return;
    const now = this.current();
    const playing = now?.run.phase === 'running';
    if (playing !== this.playing) {
      this.tray.setImage(trayIcon(playing));
      this.playing = playing;
    }
    const name = now?.instance?.name ?? 'Minecraft';
    this.tray.setToolTip(!now ? '0Rzxn_ Launcher' : t(playing ? 'tray.tooltip_playing' : 'tray.tooltip_preparing', { name }));
  }

  menu() {
    const now = this.current();
    const items = [{ label: t('tray.ouvrir_0rzxn_launcher'), click: () => this.showWindow() }, { type: 'separator' }];
    if (now) {
      const { run, instance } = now;
      const what = instance ? `${instance.name} · ${instance.version}` : 'Minecraft';
      items.push(
        { label: t('tray.en_cours'), enabled: false },
        { label: run.phase === 'running' ? t('tray.depuis_min', { what, startedAt: minutesSince(run.startedAt) }) : t('tray.preparation', { what }), enabled: false },
        { label: run.phase === 'running' ? t('tray.arreter_le_jeu') : t('tray.annuler_le_lancement'), click: () => this.confirmStop(run.phase === 'running') },
        { type: 'separator' },
      );
    }
    const recent = this.ctx.instances.list().slice(0, RECENT);
    const canPlay = !now && this.ctx.canPlay();
    items.push({ label: now ? t('tray.jouer_une_partie_est_en') : t('tray.jouer'), enabled: false });
    if (recent.length === 0) items.push({ label: t('tray.aucune_instance'), enabled: false });
    for (const instance of recent) {
      items.push({ label: `${instance.name} (${instance.version})`, enabled: canPlay, click: () => this.ctx.onLaunch(instance.id) });
    }
    items.push({ type: 'separator' }, { label: t('common.quitter'), click: () => this.ctx.onQuit() });
    return Menu.buildFromTemplate(items);
  }

  async confirmStop(running) {
    if (!running) {
      this.ctx.launches.stop();
      return;
    }
    const win = this.ctx.getWindow();
    const options = {
      type: 'warning',
      title: t('tray.arreter_le_jeu_2'),
      message: t('tray.arreter_minecraft_maintenant'),
      detail: t('tray.le_jeu_est_ferme_sans'),
      buttons: [t('common.annuler'), t('tray.arreter_le_jeu_2')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const { response } = win && !win.isDestroyed() && win.isVisible() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (response === 1) this.ctx.launches.stop();
  }
}

module.exports = { LauncherTray, trayIcon };
