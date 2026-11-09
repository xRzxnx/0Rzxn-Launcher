'use strict';

// Pont entre l'interface et le cœur : chaque canal valide ses entrées avant d'agir.
const { resolveLanguage, setLanguage, t } = require('./i18n');
const { app, dialog, ipcMain, protocol, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { journal } = require('./core/journal');
const { sanitizeSettings } = require('./core/instances');
const microsoft = require('./core/microsoft');
const { SkinStore, Wardrobe } = require('./core/skins');
const versions = require('./core/versions');
const { availableLoaders } = require('./core/loaders');
const modrinth = require('./core/modrinth');
const modpacks = require('./core/modpacks');
const profiles = require('./core/profiles');
const importer = require('./core/importer');
const worlds = require('./core/worlds');
const storage = require('./core/storage');
const performance = require('./core/performance');
const gpu = require('./core/gpu');
const { readHardware } = require('./core/hardware');
const { findSystemJavas } = require('./core/java');
const discordConfig = require('./discord-config');
const { clientId: MICROSOFT_CLIENT_ID } = require('./microsoft-config');
const { promptMicrosoftLogin } = require('./microsoft-login');
const { createServices } = require('./services/container');
const { LaunchManager, quickPlayTarget } = require('./services/launches');
const { createTaskRunner } = require('./services/tasks');
const { createBackups } = require('./services/backups');
const { createContentService } = require('./services/content');
const { createCrashService } = require('./services/crashes');
const { createShell } = require('./services/shell');

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
  const openDir = async (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
  };

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
  const trash = (file) => shell.trashItem(file);
  const contents = createContentService({ instances, trash });
  handle('content:list', (id, kind) => contents.list(id, kind));
  handle('content:versionPlan', (id, target) => contents.versionPlan(id, target));
  handle('content:toggle', (id, kind, file) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    return contents.toggle(id, kind, file);
  });
  handle('modsets:create', (id, name) => contents.createSet(id, name));
  handle('modsets:rename', (id, setId, name) => contents.renameSet(id, setId, name));
  handle('modsets:delete', (id, setId) => contents.removeSet(id, setId));
  handle('modsets:apply', (id, setId) => {
    notRunning(text(id), t('ipc.changer_ensemble_de_mods'));
    return contents.applySet(id, setId);
  });
  handle('modcheck:run', (id) => contents.check(id));
  handle('modcheck:resolve', (id) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    return contents.resolveDeps(id);
  });
  handle('content:delete', (id, kind, file) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    return contents.remove(id, kind, file);
  });
  handle('content:install', (id, kind, projectId, versionId) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    return contents.install(id, kind, projectId, versionId);
  });
  // ---------- Écran titre du jeu (menu Cristal) ----------
  handle('titlemenu:status', (id) => contents.titleStatus(id));
  handle('titlemenu:apply', (id, options) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    return contents.titleApply(id, options);
  });
  handle('titlemenu:auto', (id, options) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    return contents.titleAuto(id, options);
  });
  handle('titlemenu:disable', (id) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    return contents.titleDisable(id);
  });
  handle('content:update', (id, kind, files) => {
    notRunning(text(id), t('ipc.mettre_jour_son_contenu'));
    return contents.update(id, kind, files);
  });
  handle('content:import', (id, kind, paths) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    return contents.importFiles(id, kind, paths);
  });
  handle('content:openFolder', (id, kind) => openDir(contents.folder(id, kind)));
  handle('modrinth:search', (params) => contents.search(params));
  handle('modrinth:project', (projectId) => contents.project(projectId));
  handle('modrinth:versions', (projectId, instanceId, kind) => contents.versions(projectId, instanceId, kind));

  // ---------- Modpacks ----------
  const tasks = createTaskRunner(getWindow);
  const runTask = tasks.run;
  handle('task:cancel', () => tasks.cancel());
  const { backupBefore, backupDirOf } = createBackups({ dirs, instances, runTask, trash });
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
  // ---------- Rapports de crash ----------
  const crashService = createCrashService({ dirs, instances });
  const { crashDirs, crashPath } = crashService;
  handle('crashes:list', () => crashService.list());
  handle('crashes:read', (id, source, file) => crashService.read(id, source, file));
  handle('crashes:share', (id, source, file) => crashService.share(id, source, file));
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
    return launches.start(text(id), { verify: options?.verify === true, prepareOnly, quickPlay: prepareOnly ? null : quickPlayTarget(instances, text(id), options?.quickPlay) });
  });
  handle('launch:stop', () => launches.stop());
  handle('launch:state', () => launches.state());

  // ---------- Réglages du launcher : thème, Discord, zone de notification ----------
  const appShell = createShell({ getWindow, services, launches, isTaskBusy: () => Boolean(tasks.current()) });
  const { tray, updates } = appShell;
  handle('update:state', () => ({ ...updates.state }));
  handle('update:check', () => updates.check({ manual: true }));
  handle('update:install', () => updates.install());

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
    appShell.queueDiscord();
    return prefs;
  });
  handle('discord:status', () => appShell.discordStatus());

  // ---------- Java et espace disque ----------
  const notBusy = (action) => {
    if (launches.session) throw new Error(t('ipc.impossible_de_pendant_une_partie', { action }));
    const task = tasks.current();
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
    hideOnClose: () => appShell.hideOnClose(),
    beforeQuit: () => appShell.beforeQuit(),
  };
}

function launchArgument(argv) {
  const arg = argv.find((a) => a.startsWith('--launch='));
  const id = arg?.slice('--launch='.length) ?? '';
  return /^[a-z0-9-]+$/.test(id) ? id : null;
}

module.exports = { registerIpc };
