'use strict';

// Pont entre l'interface et le cœur : chaque canal valide ses entrées avant d'agir.
const { currentLanguage, resolveLanguage, setLanguage, t } = require('./i18n');
const { app, dialog, ipcMain, protocol, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { journal } = require('./core/journal');
const { sanitizeSettings } = require('./core/instances');
const { LaunchSession, quickPlayFile } = require('./core/launch');
const microsoft = require('./core/microsoft');
const { SkinStore, Wardrobe } = require('./core/skins');
const versions = require('./core/versions');
const { availableLoaders } = require('./core/loaders');
const content = require('./core/content');
const modCheck = require('./core/mod-check');
const modDeps = require('./core/mod-deps');
const modSets = require('./core/mod-sets');
const modrinth = require('./core/modrinth');
const titleMenu = require('./core/title-menu');
const modpacks = require('./core/modpacks');
const profiles = require('./core/profiles');
const importer = require('./core/importer');
const crashes = require('./core/crashes');
const worlds = require('./core/worlds');
const storage = require('./core/storage');
const performance = require('./core/performance');
const gpu = require('./core/gpu');
const { readHardware } = require('./core/hardware');
const { UpdateManager } = require('./core/updates');
const { findSystemJavas } = require('./core/java');
const { DiscordPresence, gameActivity } = require('./core/discord');
const { LauncherTray } = require('./tray');
const discordConfig = require('./discord-config');
const { clientId: MICROSOFT_CLIENT_ID } = require('./microsoft-config');
const { promptMicrosoftLogin } = require('./microsoft-login');
const { createServices } = require('./services/container');

const LOG_BUFFER = 5000;

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

const LOADER_NAMES = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };

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

    session.on('log', (line) => this.pushLog(line));
    session.on('progress', ({ step, done, total }) => {
      Object.assign(this.run, { step, done, total });
      this.send('launch:progress', this.run);
    });
    session.on('loaderInstalled', ({ versionId }) => instances.markLoaderInstalled(instanceId, versionId));
    session.on('prepared', () => this.finish({ prepared: true }));
    session.on('failed', ({ message, cancelled }) => this.finish({ error: cancelled ? null : message, cancelled }));
    session.on('running', () => {
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
    if (process.platform !== 'win32' || !this.services.settings.launcher().gpuHighPerformance) return;
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

  const skins = new SkinStore(dirs);
  const wardrobe = new Wardrobe({ accounts, store: skins });
  const launches = new LaunchManager(services, getWindow);

  // Les erreurs renvoyées à l'interface sont aussi notées dans le journal.
  const failed = (channel, error) => {
    journal.warn(`IPC ${channel} failed:`, error);
    throw error;
  };
  const handle = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (event.sender !== getWindow()?.webContents) throw new Error(t('ipc.origine_refusee'));
      let result;
      try {
        result = fn(...args);
      } catch (error) {
        failed(channel, error);
      }
      return result instanceof Promise ? result.catch((error) => failed(channel, error)) : result;
    });
  const text = (value) => (typeof value === 'string' ? value : '');

  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    root: dirs.root,
    microsoftReady: Boolean(MICROSOFT_CLIENT_ID),
    discordReady: Boolean(discordConfig.clientId),
  }));
  handle('system:memory', () => ({ totalGb: os.totalmem() / 1024 ** 3, freeGb: os.freemem() / 1024 ** 3 }));

  // Raccourci bureau : « --launch=<instance> » lance directement l'instance.
  let pendingLaunch = launchArgument(process.argv);
  handle('ui:get', () => {
    const ui = { ...services.settings.ui(), pendingLaunch };
    pendingLaunch = null;
    return ui;
  });
  handle('ui:set', (patch) => services.settings.setUi(patch ?? {}));

  handle('versions:list', () => versions.listVersions(dirs));
  handle('versions:details', (id) => versions.versionDetails(dirs, text(id)));
  handle('loaders:available', (mc) => availableLoaders(text(mc)));

  handle('instances:list', () => instances.list());
  handle('instances:create', (data) => instances.create(data ?? {}, services.settings.defaults()));
  // Changer de version ou de loader convertit les mondes sans retour possible : ils sont sauvegardés avant.
  handle('instances:update', async (id, patch, options) => {
    if (launches.run?.instanceId === id && patch?.version) throw new Error(t('ipc.impossible_de_changer_de_version'));
    const current = instances.get(text(id));
    const loaderChanged = patch?.loader !== undefined && (patch.loader !== current.loader || (patch.loaderVersion ?? null) !== (current.loaderVersion ?? null));
    const reason = typeof patch?.version === 'string' && patch.version !== current.version ? 'version' : loaderChanged ? 'loader' : null;
    if (reason && options?.skipBackup !== true) {
      const failed = await backupBefore(current, reason);
      if (failed) return failed;
    }
    return instances.update(text(id), patch ?? {});
  });
  const notRunning = (id, action) => {
    if (launches.run?.instanceId === id) throw new Error(t('ipc.impossible_de_pendant_que_instance', { action }));
  };
  handle('instances:duplicate', (id, name) => {
    notRunning(text(id), t('ipc.action_duplicate'));
    return instances.duplicate(text(id), text(name));
  });
  handle('instances:pickBackground', async (id) => {
    instances.get(text(id));
    const result = await dialog.showOpenDialog(getWindow(), { title: t('ipc.choisir_une_image_de_fond'), filters: [{ name: t('ipc.image_png_jpeg_webp'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }], properties: ['openFile'] });
    const file = result.filePaths?.[0];
    if (result.canceled || !file) return null;
    return instances.importBackground(text(id), file);
  });
  handle('instances:cleanBackground', (id) => instances.cleanBackgroundFiles(text(id)));
  // Fonds d'instance : fond://<instance>/<fichier>, seulement les images « fond-… » du dossier de l'instance.
  protocol.handle('fond', async (request) => {
    try {
      const url = new URL(request.url);
      const name = url.pathname.replace(/^\//, '');
      const file = instances.backgroundFile(url.hostname, name);
      if (!file) return new Response('', { status: 404 });
      const type = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[path.extname(name).slice(1)];
      return new Response(await fs.promises.readFile(file), { headers: { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' } });
    } catch {
      return new Response('', { status: 404 });
    }
  });
  // Suppression = corbeille Windows : on peut toujours récupérer ses mondes.
  handle('instances:delete', async (id) => {
    notRunning(text(id), t('ipc.action_delete'));
    instances.get(text(id));
    await shell.trashItem(instances.dir(text(id)));
    if (services.settings.ui().selectedId === id) services.settings.setUi({ selectedId: null });
  });
  handle('instances:shortcut', (id) => {
    if (process.platform !== 'win32') throw new Error(t('ipc.les_raccourcis_bureau_sont_disponibles'));
    const instance = instances.get(text(id));
    const safeName = instance.name.replace(/[\\/:*?"<>|]/g, '').trim() || instance.id;
    const file = path.join(app.getPath('desktop'), `${safeName} (0Rzxn_).lnk`);
    const options = {
      target: process.execPath,
      // En développement, Electron a besoin du dossier du projet avant les arguments.
      args: app.isPackaged ? `--launch=${instance.id}` : `"${app.getAppPath()}" --launch=${instance.id}`,
      cwd: path.dirname(process.execPath),
      description: t('ipc.lancer_avec_0rzxn_launcher', { name: instance.name }),
      icon: process.execPath,
      iconIndex: 0,
    };
    if (!shell.writeShortcutLink(file, fs.existsSync(file) ? 'replace' : 'create', options)) {
      throw new Error(t('ipc.windows_pas_pu_creer_le'));
    }
    return path.basename(file);
  });
  // ---------- Contenu des instances (mods, packs, shaders) et Modrinth ----------
  const contentCtx = (id, kind) => {
    const instance = instances.get(text(id));
    content.contentDir(instances.gameDir(instance.id), text(kind)); // valide le type
    return { instance, gameDir: instances.gameDir(instance.id), kind: text(kind) };
  };
  const trash = (file) => shell.trashItem(file);
  // Mods dont le jar annonce une autre version de Minecraft (d'après le diagnostic).
  const mismatchedJars = async (gameDir, instance) => {
    try {
      const { problems } = await modCheck.check({ gameDir, instance });
      return new Set(problems.filter((p) => p.id.startsWith('mc:')).map((p) => p.id.slice(3)));
    } catch {
      return new Set();
    }
  };
  // Chaque fichier dit s'il est prévu pour la version de l'instance : versions listées sur Modrinth, ou plage du jar.
  handle('content:list', async (id, kind) => {
    const ctx = contentCtx(id, kind);
    const data = await content.listContent(ctx);
    const flagged = ctx.kind === 'mods' ? await mismatchedJars(ctx.gameDir, ctx.instance) : new Set();
    for (const item of data.items) {
      const unlisted = Array.isArray(item.gameVersions) && item.gameVersions.length > 0 && !item.gameVersions.includes(ctx.instance.version);
      item.incompatible = flagged.has(item.file) || unlisted;
    }
    return data;
  });
  handle('content:versionPlan', async (id, target) => {
    const instance = instances.get(text(id));
    const gameDir = instances.gameDir(instance.id);
    const version = text(target);
    const localMismatch = await mismatchedJars(gameDir, { ...instance, version });
    return content.versionPlan({ gameDir, instance, target: version, localMismatch });
  });
  // Après un changement du dossier des mods, l'ensemble actif suit (nouveau mod, interrupteur, suppression).
  const setsCtx = (id) => {
    const instance = instances.get(text(id));
    return { store: instances, instance, gameDir: instances.gameDir(instance.id) };
  };
  const syncSets = (id) => modSets.sync(setsCtx(id)).catch(() => {});
  handle('content:toggle', async (id, kind, file) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    await content.toggle({ ...contentCtx(id, kind), file: text(file) });
    if (text(kind) === 'mods') await syncSets(id);
  });
  handle('modsets:create', (id, name) => modSets.create({ ...setsCtx(id), name: text(name) }));
  handle('modsets:rename', (id, setId, name) => modSets.rename({ ...setsCtx(id), setId: text(setId), name: text(name) }));
  handle('modsets:delete', (id, setId) => modSets.remove({ ...setsCtx(id), setId: text(setId) }));
  handle('modsets:apply', (id, setId) => {
    notRunning(text(id), t('ipc.changer_ensemble_de_mods'));
    return modSets.apply({ ...setsCtx(id), setId: setId == null ? null : text(setId) });
  });
  handle('modcheck:run', (id) => {
    const ctx = contentCtx(id, 'mods');
    return modCheck.check({ gameDir: ctx.gameDir, instance: ctx.instance });
  });
  // Installe ce que les mods de l'instance réclament, d'où qu'ils viennent.
  const resolveDeps = async (id) => {
    const ctx = contentCtx(id, 'mods');
    const result = await modDeps.resolve({ gameDir: ctx.gameDir, instance: ctx.instance, trash });
    if (result.installed.length) await syncSets(id);
    return result;
  };
  handle('modcheck:resolve', (id) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    return resolveDeps(id);
  });
  handle('content:delete', async (id, kind, file) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    const ctx = contentCtx(id, kind);
    await trash(content.safePath(content.contentDir(ctx.gameDir, ctx.kind), text(file)));
    if (ctx.kind === 'mods') await syncSets(id);
  });
  handle('content:install', async (id, kind, projectId, versionId) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    const result = await content.install({ ...contentCtx(id, kind), projectId: text(projectId), versionId: text(versionId) || null, trash });
    if (text(kind) !== 'mods') return result;
    await syncSets(id);
    // Le jar peut réclamer plus que ce que sa page Modrinth annonce.
    const extra = await resolveDeps(id).catch(() => null);
    return {
      installed: [...result.installed, ...(extra?.installed ?? [])],
      missingDependencies: Math.max(result.missingDependencies, extra?.unresolved.length ?? 0),
    };
  });
  // ---------- Écran titre du jeu (menu Cristal) ----------
  const titleStatus = (id) => {
    const ctx = contentCtx(id, 'mods');
    const versions = () => modrinth.versions(titleMenu.FANCYMENU, { loaders: content.loadersFor('mods', ctx.instance), gameVersion: ctx.instance.version });
    return titleMenu.status({ gameDir: ctx.gameDir, instance: ctx.instance, versions });
  };
  handle('titlemenu:status', (id) => titleStatus(id));
  const applyTitleMenu = async (id, options, before) => {
    const ctx = contentCtx(id, 'mods');
    if (!before.installed) {
      await content.install({ ...ctx, projectId: titleMenu.FANCYMENU, trash });
      await syncSets(id);
    }
    const instance = instances.update(text(id), { titleMenu: options ?? {} });
    await titleMenu.refresh({ gameDir: ctx.gameDir, instance });
  };
  handle('titlemenu:apply', async (id, options) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    await applyTitleMenu(id, options, await titleStatus(id));
    return titleStatus(id);
  });
  // Avant chaque lancement : une instance moddée jamais réglée reçoit le menu Cristal.
  // Version sans FancyMenu : retenue jusqu'à la fermeture du launcher, pour ne pas redemander à chaque partie.
  const titleUnavailable = new Map();
  handle('titlemenu:auto', async (id, options) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    const { instance } = contentCtx(id, 'mods');
    const key = `${instance.version}/${instance.loader}`;
    if (!titleMenu.wantsAuto(instance) || titleUnavailable.get(instance.id) === key) return { added: false };
    const before = await titleStatus(id);
    if (before.available === false) titleUnavailable.set(instance.id, key);
    // Mod connu pour planter avec FancyMenu, ou Modrinth injoignable : on réessaiera au prochain lancement.
    if (!before.available || before.conflicts.length) return { added: false };
    await applyTitleMenu(id, options ?? {}, before);
    return { added: true, installed: !before.installed };
  });
  handle('titlemenu:disable', async (id) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    await titleMenu.removeMenu(contentCtx(id, 'mods').gameDir);
    instances.update(text(id), { titleMenu: null });
    return titleStatus(id);
  });
  handle('content:update', async (id, kind, files) => {
    notRunning(text(id), t('ipc.mettre_jour_son_contenu'));
    const result = await content.update({ ...contentCtx(id, kind), files: Array.isArray(files) ? files.map(text) : null, trash });
    if (text(kind) === 'mods') await syncSets(id);
    return result;
  });
  handle('content:import', async (id, kind, paths) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    const result = await content.importFiles({ ...contentCtx(id, kind), paths: Array.isArray(paths) ? paths.map(text) : [] });
    if (text(kind) === 'mods') await syncSets(id);
    return result;
  });
  handle('content:openFolder', async (id, kind) => {
    const ctx = contentCtx(id, kind);
    const dir = content.contentDir(ctx.gameDir, ctx.kind);
    fs.mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
  });
  handle('modrinth:search', ({ instanceId, kind, query, sort, offset } = {}) => {
    // Les modpacks créent une nouvelle instance : pas de filtre sur l'instance sélectionnée.
    if (kind === 'modpacks') {
      return modrinth.search({ query: text(query), projectType: 'modpack', sort: text(sort), offset: Number(offset) || 0 });
    }
    const { instance } = contentCtx(instanceId, kind);
    return modrinth.search({
      query: text(query),
      projectType: content.KINDS[kind].projectType,
      gameVersion: instance.version,
      loaders: content.loadersFor(kind, instance),
      sort: text(sort),
      offset: Number(offset) || 0,
    });
  });
  handle('modrinth:project', (projectId) => modrinth.project(text(projectId)));
  handle('modrinth:versions', (projectId, instanceId, kind) => {
    if (kind === 'modpacks') return modrinth.versions(text(projectId), {});
    const { instance } = contentCtx(instanceId, kind);
    return modrinth.versions(text(projectId), { loaders: content.loadersFor(kind, instance), gameVersion: instance.version });
  });

  // ---------- Modpacks ----------
  // Une seule tâche longue à la fois (installation ou mise à jour d'un modpack), avec sa progression.
  let task = null;
  let taskAbort = null; // les tâches qui acceptent un signal (sauvegarde, restauration) peuvent être annulées
  const runTask = async (label, work, { cancellable = false } = {}) => {
    if (task) throw new Error(t('ipc.patiente_est_en_cours', { task }));
    task = label;
    taskAbort = cancellable ? new AbortController() : null;
    const send = (payload) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('task:progress', payload);
    };
    send({ label, done: 0, total: 0, cancellable });
    try {
      return await work((p) => send({ label: p.label ?? label, done: p.done, total: p.total, cancellable }), taskAbort?.signal);
    } finally {
      task = null;
      taskAbort = null;
      send(null);
    }
  };
  handle('task:cancel', () => taskAbort?.abort());

  // Sauvegarde automatique des mondes avant une opération risquée (reason : modpack, version, loader, launch).
  // Renvoie null si rien n'était à faire ; lève une erreur si la copie échoue (l'opération est alors arrêtée).
  const worldsToBackUp = (instance, reason) => {
    const s = instance.settings;
    if (reason === 'launch') {
      if (s.backupLaunch === 'never') return null;
      return s.backupLaunch === 'hardcore' ? (w) => w.hardcore : () => true;
    }
    return s.backupAuto ? () => true : null;
  };
  const autoBackup = (instance, reason, onProgress, signal) => {
    const filter = worldsToBackUp(instance, reason);
    const gameDir = instances.gameDir(instance.id);
    if (!filter || !worlds.scanWorlds(gameDir).some(filter)) return null;
    const label = t('ipc.sauvegarde_des_mondes');
    return worlds.backupAll({
      gameDir, backupDir: path.join(dirs.backups, instance.id), reason, keep: instance.settings.backupKeep, trash, filter, signal,
      onProgress: (p) => onProgress({ ...p, label: p.world ? t('ipc.sauvegarde_de', { name: p.world }) : label }),
    });
  };
  /** Sauvegarde automatique seule, comme tâche : { backupError } si elle échoue, null sinon. */
  const backupBefore = async (instance, reason) => {
    if (!worldsToBackUp(instance, reason) || !worlds.scanWorlds(instances.gameDir(instance.id)).some(worldsToBackUp(instance, reason))) return null;
    try {
      await runTask(t('ipc.sauvegarde_des_mondes'), (onProgress, signal) => autoBackup(instance, reason, onProgress, signal), { cancellable: true });
      return null;
    } catch (error) {
      return { backupError: error.message };
    }
  };
  const installFromBuffer = (label, buffer, source) =>
    runTask(label, (onProgress) => modpacks.installPack({ instances, buffer, defaults: services.settings.defaults(), source, onProgress }));

  handle('modpacks:install', async (projectId, versionId, meta) => {
    const id = text(projectId);
    const chosen = text(versionId) || (await modrinth.versions(id, {}))[0]?.id;
    if (!chosen) throw new Error(t('ipc.ce_modpack_aucune_version_telechargeable'));
    const { buffer } = await modpacks.downloadPack(dirs, chosen);
    return installFromBuffer(t('ipc.installation_de', { title: text(meta?.title) || 'modpack' }), buffer, {
      projectId: id,
      versionId: chosen,
      title: text(meta?.title) || undefined,
      icon: text(meta?.icon) || null,
    });
  });
  handle('modpacks:import', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: t('ipc.importer_un_modpack'),
      properties: ['openFile'],
      filters: [{ name: t('ipc.modpack_modrinth'), extensions: ['mrpack'] }],
    });
    if (result.canceled) return null;
    const buffer = await fs.promises.readFile(result.filePaths[0]);
    return installFromBuffer(t('ipc.import_de', { filePaths: path.basename(result.filePaths[0]) }), buffer, null);
  });
  handle('modpacks:checkUpdate', (id) => modpacks.checkUpdate(instances.get(text(id))));
  handle('modpacks:update', async (id, versionId, options) => {
    notRunning(text(id), t('ipc.mettre_jour_le_modpack'));
    const instance = instances.get(text(id));
    if (options?.skipBackup !== true) {
      const failed = await backupBefore(instance, 'modpack');
      if (failed) return failed;
    }
    const { buffer } = await modpacks.downloadPack(dirs, text(versionId));
    return runTask(t('ipc.mise_jour_de', { name: instance.name }), (onProgress) =>
      modpacks.updatePack({ instances, instanceId: instance.id, buffer, source: { versionId: text(versionId) }, trash, onProgress }),
    );
  });
  // ---------- Import (instances d'autres launchers, mondes) ----------
  // Seuls les dossiers trouvés par une recherche peuvent être importés ; la source est seulement lue.
  const scanned = new Map(); // chemin → nom du launcher (instance) ou 'world'
  const pickFolder = async (title, defaultPath) => {
    const result = await dialog.showOpenDialog(getWindow(), { title, defaultPath, properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  };
  const instancesFrom = (dir) => {
    const found = importer.scanInstances(dir);
    const imported = new Set(instances.list().map((i) => i.importedFrom?.path).filter(Boolean));
    for (const item of found.instances) {
      scanned.set(item.path, found.launcher);
      item.imported = imported.has(item.path);
    }
    return found;
  };
  handle('import:scanInstances', () => instancesFrom(importer.defaultInstancesDir(app.getPath('appData'))));
  handle('import:pickInstances', async () => {
    const dir = await pickFolder(t('ipc.dossier_instances_un_autre_launcher'), importer.defaultInstancesDir(app.getPath('appData')));
    return dir ? instancesFrom(dir) : null;
  });
  handle('import:instance', (dir) => {
    const source = text(dir);
    const launcher = scanned.get(source);
    if (!launcher) throw new Error(t('ipc.instance_inconnue_relance_la_recherche'));
    return runTask(t('ipc.import_de_2', { source: path.basename(source) }), (onProgress) =>
      importer.importInstance({ instances, dir: source, defaults: services.settings.defaults(), launcher, onProgress }),
    );
  });
  const openDir = async (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
  };

  // ---------- Rapports de crash ----------
  const crashDirs = (id) => {
    const instance = instances.get(text(id));
    return { instance, gameDir: instances.gameDir(instance.id), instanceDir: instances.dir(instance.id) };
  };
  const summaries = new Map(); // « chemin:date » → type d'erreur reconnu, pour la liste
  handle('crashes:list', async () => {
    const all = [];
    for (const instance of instances.list()) {
      const found = await crashes.listCrashes(crashDirs(instance.id)).catch(() => []);
      for (const item of found) all.push({ ...item, instanceId: instance.id, instanceName: instance.name });
    }
    const recent = all.sort((a, b) => b.at - a.at).slice(0, 40);
    await Promise.all(
      recent.map(async (item) => {
        const file = crashes.crashFile(crashDirs(item.instanceId), item.source, item.file);
        const key = `${currentLanguage()}:${file}:${item.at}`;
        if (!summaries.has(key)) {
          const body = await crashes.readCrashText(file).then((r) => r.text, () => '');
          summaries.set(key, crashes.diagnose(body).problems[0]?.label ?? null);
        }
        item.label = summaries.get(key);
      }),
    );
    return recent;
  });
  const crashPath = (id, source, file) => crashes.crashFile(crashDirs(id), text(source), text(file));
  handle('crashes:read', async (id, source, file) => {
    const { instance } = crashDirs(id);
    const report = await crashes.readCrashText(crashPath(id, source, file));
    const java = instance.settings.java === 'custom' ? null : await versions.versionDetails(dirs, instance.version).then((d) => d.java, () => null);
    return { ...report, ...crashes.diagnose(report.text, { java, ram: instance.settings.ram, javaMode: instance.settings.java }) };
  });
  handle('crashes:share', async (id, source, file) => crashes.shareLog((await crashes.readCrashText(crashPath(id, source, file))).text));
  handle('crashes:open', async (id, source, file) => {
    const error = await shell.openPath(crashPath(id, source, file));
    if (error) throw new Error(error);
  });
  handle('crashes:openFolder', (id) => openDir(path.join(crashDirs(id).gameDir, 'crash-reports')));

  handle('instances:export', async (id, options) => {
    const instance = instances.get(text(id));
    const name = text(options?.name).trim() || instance.name;
    const version = text(options?.version).trim() || '1.0.0';
    const result = await dialog.showSaveDialog(getWindow(), {
      title: t('ipc.exporter_en_modpack'),
      defaultPath: path.join(app.getPath('desktop'), `${name.replace(/[\\/:*?"<>|]/g, '')}-${version}.mrpack`),
      filters: [{ name: t('ipc.modpack_modrinth'), extensions: ['mrpack'] }],
    });
    if (result.canceled) return null;
    const pack = await modpacks.exportPack({ instance, gameDir: instances.gameDir(instance.id), name, version, summary: text(options?.summary) });
    await fs.promises.writeFile(result.filePath, pack.buffer);
    return { file: result.filePath, referenced: pack.referenced, embedded: pack.embedded, size: pack.buffer.length };
  });


  // Bilan mensuel : le processus principal vérifie que le contenu reçu est bien un PNG de taille raisonnable.
  const RECAP_MAX_BYTES = 4 * 1024 * 1024;
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  handle('stats:saveRecapImage', async (month, bytes) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text(month))) throw new Error(t('ipc.mois_invalide'));
    if (!(bytes instanceof Uint8Array) || bytes.length < 33 || bytes.length > RECAP_MAX_BYTES) throw new Error(t('ipc.image_refusee_taille_inattendue'));
    const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
    const header = png.subarray(12, 16).toString('latin1') === 'IHDR';
    const tooBig = png.readUInt32BE(16) > 4096 || png.readUInt32BE(20) > 4096;
    if (!png.subarray(0, 8).equals(PNG_SIGNATURE) || !header || tooBig) throw new Error(t('ipc.image_refusee_ce_est_pas'));
    const result = await dialog.showSaveDialog(getWindow(), {
      title: t('ipc.enregistrer_le_bilan_du_mois'),
      defaultPath: path.join(app.getPath('pictures'), t('ipc.bilan_png', { month })),
      filters: [{ name: t('ipc.image_png'), extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.promises.writeFile(result.filePath, png);
    return result.filePath;
  });

  handle('instances:openFolder', async (id) => {
    const dir = instances.gameDir(text(id));
    fs.mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
  });
  // ---------- Mondes et sauvegardes ----------
  const backupDirOf = (id) => path.join(dirs.backups, instances.get(id).id);
  // Ordre de sortie des versions (manifeste Mojang déjà chargé) : sert à repérer un monde enregistré par une version plus récente.
  const releaseOrder = async () => {
    try {
      const manifest = await versions.getManifest(dirs);
      return new Map(manifest.versions.map((v) => [v.id, Date.parse(v.releaseTime)]));
    } catch {
      return new Map();
    }
  };
  handle('worlds:list', async (id) => {
    const instance = instances.get(text(id));
    const [list, backups, order] = await Promise.all([worlds.listWorlds(instances.gameDir(instance.id)), worlds.listBackups(backupDirOf(instance.id)), releaseOrder()]);
    const mine = order.get(instance.version);
    return {
      worlds: list.map((w) => ({ ...w, newer: Boolean(mine && order.get(w.version) > mine) })),
      backups,
    };
  });
  handle('worlds:backup', (id, folder) => {
    const instance = instances.get(text(id));
    notRunning(instance.id, t('ipc.sauvegarder_un_monde'));
    return runTask(
      t('ipc.sauvegarde_de', { name: text(folder) }),
      (onProgress, signal) => worlds.backupWorld({ gameDir: instances.gameDir(instance.id), folder: text(folder), backupDir: backupDirOf(instance.id), signal, onProgress }),
      { cancellable: true },
    );
  });
  handle('worlds:restore', (id, file, mode) => {
    const instance = instances.get(text(id));
    notRunning(instance.id, t('ipc.restaurer_un_monde'));
    const zipFile = worlds.backupFile(backupDirOf(instance.id), text(file));
    return runTask(
      t('ipc.restauration_de', { name: text(file) }),
      (onProgress, signal) => worlds.restoreWorld({ zipFile, gameDir: instances.gameDir(instance.id), mode: text(mode) === 'replace' ? 'replace' : 'beside', trash, signal, onProgress }),
      { cancellable: true },
    );
  });
  handle('worlds:delete', (id, folder) => {
    notRunning(text(id), t('ipc.supprimer_un_monde'));
    return worlds.deleteWorld({ gameDir: instances.gameDir(text(id)), folder: text(folder), trash });
  });
  handle('worlds:deleteBackup', (id, file) => worlds.deleteBackup({ backupDir: backupDirOf(text(id)), file: text(file), trash }));
  handle('worlds:openFolder', async (id, folder) => {
    const gameDir = instances.gameDir(text(id));
    const dir = folder ? worlds.worldDir(gameDir, text(folder)) : path.join(gameDir, 'saves');
    fs.mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
  });

  handle('launcher:openFolder', async () => {
    const error = await shell.openPath(dirs.root);
    if (error) throw new Error(error);
  });

  handle('accounts:list', () => accounts.list());
  handle('accounts:addOffline', (name) => accounts.addOffline(text(name)));
  handle('accounts:addMicrosoft', async () => {
    if (!MICROSOFT_CLIENT_ID) {
      throw new Error(t('ipc.la_connexion_microsoft_est_pas'));
    }
    const { code, verifier } = await promptMicrosoftLogin(getWindow(), MICROSOFT_CLIENT_ID);
    const session = await microsoft.signIn(MICROSOFT_CLIENT_ID, code, verifier);
    return { ...accounts.addMicrosoft(session), name: session.name };
  });
  handle('accounts:remove', (id) => accounts.remove(text(id)));
  handle('accounts:setActive', (id) => accounts.setActive(text(id)));
  handle('accounts:refreshLooks', () => wardrobe.refresh());

  // ---------- Skins et capes ----------
  // Les images passent par skin://texture/<empreinte> et skin://library/<id> : seulement le cache et « Mes skins ».
  protocol.handle('skin', async (request) => {
    try {
      const url = new URL(request.url);
      const id = url.pathname.replace(/^\//, '');
      const file = url.hostname === 'library' ? skins.skinFile(id) : await skins.texture(id);
      return new Response(await fs.promises.readFile(file), { headers: { 'Content-Type': 'image/png' } });
    } catch {
      return new Response('', { status: 404 });
    }
  });
  handle('skins:state', (id) => wardrobe.state(text(id)));
  handle('skins:library', () => skins.list());
  handle('skins:import', async () => {
    const result = await dialog.showOpenDialog(getWindow(), { title: t('ipc.importer_un_skin'), filters: [{ name: t('ipc.skin_minecraft_png'), extensions: ['png'] }], properties: ['openFile'] });
    const file = result.filePaths?.[0];
    if (result.canceled || !file) return null;
    const stat = await fs.promises.stat(file);
    if (stat.size > 2 * 1024 * 1024) throw new Error(t('common.ce_fichier_est_trop_lourd'));
    const { item, added } = skins.add(await fs.promises.readFile(file), { name: path.basename(file), variant: 'classic' });
    return { id: item.id, added, library: skins.list() };
  });
  handle('skins:copyPlayer', async (name) => {
    const { item, added } = await wardrobe.copyPlayer(text(name));
    return { id: item.id, name: item.name, added, library: skins.list() };
  });
  handle('skins:setVariant', (id, variant) => {
    skins.setVariant(text(id), text(variant));
    return skins.list();
  });
  handle('skins:remove', (id) => {
    skins.remove(text(id));
    return skins.list();
  });
  // Un refus de Mojang revient dans l'état (avec son code) : ce qui a déjà été appliqué reste à jour à l'écran.
  const attempt = async (id, action) => {
    try {
      return await action();
    } catch (error) {
      return wardrobe.snapshot(id, error);
    }
  };
  handle('skins:apply', (id, change) => attempt(text(id), () => wardrobe.apply(text(id), change ?? {})));
  handle('skins:reset', (id) => attempt(text(id), () => wardrobe.reset(text(id))));

  handle('settings:get', () => services.settings.defaults());
  handle('settings:update', (patch) => services.settings.setDefaults(patch ?? {}));
  handle('dialog:pickJava', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: t('ipc.choisir_un_java'),
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : [],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('launch:start', async (id, options) => {
    const prepareOnly = options?.prepareOnly === true;
    if (!prepareOnly && options?.skipBackup !== true) {
      if (launches.session) throw new Error(t('ipc.une_partie_ou_une_installation'));
      const failed = await backupBefore(instances.get(text(id)), 'launch');
      if (failed) return failed;
    }
    return launches.start(text(id), { verify: options?.verify === true, prepareOnly, quickPlay: prepareOnly ? null : quickPlayTarget(text(id), options?.quickPlay) });
  });
  /** Monde ou serveur demandé par l'interface : un monde doit exister dans l'instance, une adresse rester une adresse. */
  const quickPlayTarget = (id, target) => {
    if (!target || (target.type !== 'singleplayer' && target.type !== 'multiplayer')) return null;
    const name = text(target.name).slice(0, 100);
    if (target.type === 'singleplayer') {
      worlds.worldDir(instances.gameDir(id), text(target.id)); // lève une erreur si le monde n'existe plus
      return { type: 'singleplayer', id: text(target.id), name };
    }
    const address = text(target.id).trim();
    if (!/^[\w.\-:[\]]{1,255}$/.test(address)) throw new Error(t('ipc.adresse_de_serveur_invalide'));
    return { type: 'multiplayer', id: address, name };
  };
  handle('launch:stop', () => launches.stop());
  handle('launch:state', () => launches.state());

  // ---------- Réglages du launcher : thème, Discord, zone de notification ----------
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
  const tray = new LauncherTray({ getWindow, instances, launches, canPlay: () => Boolean(accounts.list().activeId), onLaunch: requestLaunch, onQuit: quit });

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

  // Mises à jour du launcher : seulement dans la version installée, et jamais pendant une partie.
  const updates = new UpdateManager({
    supported: app.isPackaged,
    loadUpdater: () => require('electron-updater').autoUpdater,
    isBusy: () => Boolean(launches.session || task),
    isAutomatic: () => services.settings.launcher().autoUpdate,
    onState: (status) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('update:status', status);
    },
    log: app.isPackaged ? updateLog(path.join(app.getPath('userData'), 'mises-a-jour.log')) : null,
  });
  handle('update:state', () => ({ ...updates.state }));
  handle('update:check', () => updates.check({ manual: true }));
  handle('update:install', () => updates.install());
  updates.start();

  handle('launcher:get', () => services.settings.launcher());
  // La langue change sans redémarrer : messages d'erreur, dialogues et zone de notification suivent aussitôt.
  handle('launcher:setLanguage', (language) => {
    services.settings.setLauncher({ language });
    const next = applyLanguage();
    tray.refresh();
    return next;
  });
  handle('launcher:set', (patch) => {
    const prefs = services.settings.setLauncher(patch ?? {});
    tray.setEnabled(prefs.tray);
    queueDiscord();
    return prefs;
  });
  handle('discord:status', async () => ({
    configured: Boolean(discordConfig.clientId),
    running: await presence.isRunning(),
    showing: Boolean(presence.socket && presence.activity),
  }));

  // ---------- Java et espace disque ----------
  const notBusy = (action) => {
    if (launches.session) throw new Error(t('ipc.impossible_de_pendant_une_partie', { action }));
    if (task) throw new Error(t('ipc.patiente_est_en_cours', { task }));
  };
  let systemJavas = null;
  handle('java:runtimes', () => storage.runtimesWithUsage(dirs, instances.list()));
  handle('java:system', async (refresh) => {
    if (!systemJavas || refresh === true) systemJavas = await findSystemJavas(dirs);
    return systemJavas;
  });
  const runtimeDir = (component) => {
    const name = text(component);
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(t('ipc.java_inconnu'));
    return path.join(dirs.runtime, name);
  };
  handle('java:removeRuntime', async (component) => {
    notBusy(t('ipc.supprimer_un_java'));
    const runtime = (await storage.runtimesWithUsage(dirs, instances.list())).find((r) => r.component === text(component));
    if (!runtime) throw new Error(t('ipc.ce_java_est_deja_supprime'));
    if (runtime.usedBy.length) throw new Error(t('ipc.ce_java_sert_encore', { usedBy: runtime.usedBy.join(', ') }));
    await fs.promises.rm(runtimeDir(component), { recursive: true, force: true });
    return runtime.size;
  });
  handle('java:openRuntime', (component) => openDir(runtimeDir(component)));
  // ---------- Performances ----------
  const cpus = os.cpus().length;
  // Conseil de mémoire : charge de l'instance (mods, shaders, ZGC) et composants du PC.
  const ramAdvice = async (instance, gc, counts) => {
    const pc = await readHardware();
    const shaders = instance ? await performance.activeShaders({ gameDir: instances.gameDir(instance.id), instance }).catch(() => 0) : 0;
    const guide = performance.ramGuide({ loader: instance?.loader, version: instance?.version, mods: counts.mods, shaders, zgc: gc, totalGb: pc.totalGb, integrated: pc.integrated });
    return { ...guide, mods: counts.mods, shaders, pc: { summary: pc.summary, detail: pc.detail } };
  };
  handle('perf:ramGuide', async (id, settings) => {
    const instance = id ? instances.get(text(id)) : null;
    const s = sanitizeSettings(settings ?? {}, instance?.settings ?? services.settings.defaults());
    const counts = instance ? await performance.packInstalledCount({ gameDir: instances.gameDir(instance.id), instance }).catch(() => ({ mods: 0 })) : { mods: 0 };
    return ramAdvice(instance, s.jvmPreset === 'zgc', counts);
  });
  handle('perf:preview', async (id, settings) => {
    const instance = id ? instances.get(text(id)) : null;
    const s = sanitizeSettings(settings ?? {}, instance?.settings ?? services.settings.defaults());
    const javaMajor = instance ? ((await versions.versionDetails(dirs, instance.version).catch(() => null))?.java ?? null) : null;
    const tuned = performance.jvmArguments({ preset: s.jvmPreset, javaMajor: javaMajor ?? 21, ramGb: s.ram, jvmArgs: s.jvmArgs, cpus });
    const counts = instance ? await performance.packInstalledCount({ gameDir: instances.gameDir(instance.id), instance }) : { installed: 0, mods: 0 };
    const advice = await ramAdvice(instance, s.jvmPreset === 'zgc' && tuned.gc === 'zgc', counts);
    return {
      javaMajor,
      cpus,
      gc: tuned.gc,
      userGc: performance.userChoosesGc(s.jvmArgs),
      args: tuned.args,
      ram: instance ? advice.ideal : null,
      pc: advice.pc.summary,
      mods: counts.mods,
      packInstalled: counts.installed,
    };
  });
  handle('perf:pack', (id) => {
    const instance = instances.get(text(id));
    return performance.packStatus({ gameDir: instances.gameDir(instance.id), instance });
  });
  handle('perf:installPack', async (id, slugs, options) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    let instance = instances.get(text(id));
    const list = Array.isArray(slugs) ? slugs.map(text) : [];
    // Instance vanilla : passage en Fabric (mondes et réglages gardés), comme « Modifier › Loader ».
    if (instance.loader === 'vanilla') {
      if (options?.convert !== true) throw new Error(t('ipc.cette_instance_est_vanilla_il'));
      const fabric = (await availableLoaders(instance.version)).fabric;
      if (!fabric?.recommended) throw new Error(t('ipc.fabric_existe_pas_pour_minecraft', { version: instance.version }));
      instance = instances.update(instance.id, { loader: 'fabric', loaderVersion: fabric.recommended });
    }
    const result = await runTask(t('ipc.pack_performances'), (onProgress) =>
      performance.installPack({ gameDir: instances.gameDir(instance.id), instance, slugs: list, trash, onProgress }),
    );
    return { ...result, instance };
  });
  // ---------- Assistant de création : profils prêts à jouer ----------
  const hasFabric = (mc) => availableLoaders(mc).then((l) => Boolean(l.fabric?.recommended), () => false);
  const profileRam = async (p, version) => {
    const pc = await readHardware();
    return performance.ramGuide({ loader: p.loader, version, mods: p.mods.length, shaders: p.shaders ? 1 : 0, totalGb: pc.totalGb, integrated: pc.integrated });
  };
  handle('profiles:plan', async (profileId, version) => {
    const p = profiles.profile(text(profileId));
    const listed = await versions.listVersions(dirs);
    const releases = listed.versions.filter((v) => v.type === 'release').map((v) => v.id);
    const result = await profiles.plan({ profileId: p.id, version: text(version) || null, releases, hasLoader: hasFabric });
    const guide = await profileRam(p, result.version);
    return { ...result, ram: { ideal: guide.ideal, low: guide.low, high: guide.high, limited: guide.limited } };
  });
  handle('profiles:create', async (data) => {
    const p = profiles.profile(text(data?.profile));
    const version = text(data?.version);
    let loaderVersion = null;
    if (p.loader !== 'vanilla') {
      loaderVersion = (await availableLoaders(version)).fabric?.recommended;
      if (!loaderVersion) throw new Error(t('ipc.fabric_existe_pas_pour_minecraft_2', { version }));
    }
    const created = instances.create({ ...data, version, loader: p.loader, loaderVersion }, services.settings.defaults());
    const guide = await profileRam(p, version);
    return instances.update(created.id, { settings: { ...created.settings, ram: guide.ideal } });
  });
  handle('profiles:installMods', (id, profileId) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    const instance = instances.get(text(id));
    const p = profiles.profile(text(profileId));
    return runTask(t('ipc.mods_du_profil', { title: p.title }), (onProgress) =>
      profiles.installMods({ profileId: p.id, gameDir: instances.gameDir(instance.id), instance, trash, onProgress }),
    );
  });
  // Temps processeur cumulé des processus du launcher, comparé au relevé précédent (percentCPUUsage sous-estime beaucoup).
  let lastMetrics = null;
  handle('perf:metrics', () => {
    let seconds = 0;
    let memoryKb = 0;
    for (const p of app.getAppMetrics()) {
      seconds += p.cpu.cumulativeCPUUsage ?? 0;
      memoryKb += p.memory.workingSetSize;
    }
    const now = Date.now();
    const elapsed = lastMetrics ? (now - lastMetrics.at) / 1000 : 0;
    // En % du processeur entier, comme le Gestionnaire des tâches.
    const cpu = elapsed > 0 ? Math.max(0, (100 * (seconds - lastMetrics.seconds)) / elapsed / cpus) : 0;
    lastMetrics = { at: now, seconds };
    return { cpu, memoryMb: memoryKb / 1024, running: launches.run?.phase === 'running' };
  });
  // Java du launcher (et Java personnalisés des instances) concernés par la préférence de carte graphique.
  const javaExes = () => {
    const found = new Set();
    for (const name of fs.existsSync(dirs.runtime) ? fs.readdirSync(dirs.runtime) : []) {
      const exe = path.join(dirs.runtime, name, 'bin', 'java.exe');
      if (fs.existsSync(exe)) found.add(exe);
    }
    for (const i of instances.list()) if (i.settings.java === 'custom' && i.settings.javaPath && fs.existsSync(i.settings.javaPath)) found.add(i.settings.javaPath);
    return [...found];
  };
  handle('gpu:status', async () => {
    const gpus = await gpu.listGpus().catch(() => []);
    const exes = javaExes();
    const prefs = await Promise.all(exes.map((exe) => gpu.preference(exe)));
    return { gpus, javas: exes.length, high: prefs.filter((p) => p === 'high').length, enabled: services.settings.launcher().gpuHighPerformance };
  });
  // Le réglage de Windows n'est écrit qu'après l'accord donné dans la fenêtre de confirmation.
  handle('gpu:set', async (on) => {
    const exes = javaExes();
    if (on === true) await gpu.setHighPerformance(exes);
    else await gpu.clearPreference(exes);
    return services.settings.setLauncher({ gpuHighPerformance: on === true });
  });
  handle('storage:usage', () => storage.usage(dirs));
  handle('storage:plan', async () => (await storage.cleanupPlan(dirs, instances.list())).map(({ paths, ...item }) => item));
  handle('storage:clean', (ids) => {
    notBusy(t('ipc.liberer_de_espace'));
    return storage.clean(dirs, instances.list(), Array.isArray(ids) ? ids.map(text) : []);
  });

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

function launchArgument(argv) {
  const arg = argv.find((a) => a.startsWith('--launch='));
  const id = arg?.slice('--launch='.length) ?? '';
  return /^[a-z0-9-]+$/.test(id) ? id : null;
}

module.exports = { registerIpc };
