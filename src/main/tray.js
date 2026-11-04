'use strict';

// Icône dans la zone de notification : clic = afficher ou masquer le launcher,
// clic droit = partie en cours, instances récentes et Quitter.
const path = require('node:path');
const { Menu, Tray, dialog, nativeImage } = require('electron');

const RECENT = 5;

/** Icône de la zone de notification (tray.png et tray@2x.png), avec une pastille verte pendant une partie. */
function trayIcon(playing) {
  return nativeImage.createFromPath(path.join(__dirname, 'assets', playing ? 'tray-playing.png' : 'tray.png'));
}

const minutesSince = (at) => Math.max(0, Math.round((Date.now() - at) / 60000));

/**
 * `ctx` : getWindow, instances (InstanceStore), launches (LaunchManager), canPlay(), onLaunch(id), onQuit().
 * L'icône suit la partie en cours grâce à `refresh()`, appelé à chaque changement d'état.
 */
class LauncherTray {
  constructor(ctx) {
    this.ctx = ctx;
    this.tray = null;
    this.playing = null;
  }

  get enabled() {
    return Boolean(this.tray);
  }

  setEnabled(on) {
    if (on && !this.tray) {
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
    if (!win || win.isDestroyed()) return;
    if (win.isVisible() && !win.isMinimized() && win.isFocused()) win.hide();
    else this.showWindow();
  }

  showWindow() {
    const win = this.ctx.getWindow();
    if (!win || win.isDestroyed()) return;
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
    this.tray.setToolTip(!now ? '0Rzxn_ Launcher' : playing ? `0Rzxn_ Launcher · ${name} en cours` : `0Rzxn_ Launcher · ${name} se prépare`);
  }

  menu() {
    const now = this.current();
    const items = [{ label: 'Ouvrir 0Rzxn_ Launcher', click: () => this.showWindow() }, { type: 'separator' }];
    if (now) {
      const { run, instance } = now;
      const what = instance ? `${instance.name} · ${instance.version}` : 'Minecraft';
      items.push(
        { label: 'En cours', enabled: false },
        { label: run.phase === 'running' ? `${what} · depuis ${minutesSince(run.startedAt)} min` : `${what} · préparation`, enabled: false },
        { label: run.phase === 'running' ? 'Arrêter le jeu…' : 'Annuler le lancement', click: () => this.confirmStop(run.phase === 'running') },
        { type: 'separator' },
      );
    }
    const recent = this.ctx.instances.list().slice(0, RECENT);
    const canPlay = !now && this.ctx.canPlay();
    items.push({ label: now ? 'Jouer (une partie est en cours)' : 'Jouer', enabled: false });
    if (recent.length === 0) items.push({ label: 'Aucune instance', enabled: false });
    for (const instance of recent) {
      items.push({ label: `${instance.name} (${instance.version})`, enabled: canPlay, click: () => this.ctx.onLaunch(instance.id) });
    }
    items.push({ type: 'separator' }, { label: 'Quitter', click: () => this.ctx.onQuit() });
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
      title: 'Arrêter le jeu',
      message: 'Arrêter Minecraft maintenant ?',
      detail: "Le jeu est fermé sans sauvegarder la partie en cours. Préfère « Sauvegarder et quitter » dans le jeu quand c'est possible.",
      buttons: ['Annuler', 'Arrêter le jeu'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const { response } = win && !win.isDestroyed() && win.isVisible() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (response === 1) this.ctx.launches.stop();
  }
}

module.exports = { LauncherTray, trayIcon };
