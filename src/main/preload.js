'use strict';

// Seul point de contact entre l'interface et Electron : une API explicite, rien d'autre.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const listen = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('launcher', {
  info: invoke('app:info'),
  memory: invoke('system:memory'),
  openLauncherFolder: invoke('launcher:openFolder'),
  pickJava: invoke('dialog:pickJava'),
  saveRecapImage: invoke('stats:saveRecapImage'),
  // Chemin d'un fichier glissé-déposé dans la fenêtre
  filePath: (file) => webUtils.getPathForFile(file),
  content: {
    list: invoke('content:list'),
    toggle: invoke('content:toggle'),
    remove: invoke('content:delete'),
    install: invoke('content:install'),
    update: invoke('content:update'),
    import: invoke('content:import'),
    openFolder: invoke('content:openFolder'),
    check: invoke('modcheck:run'),
  },
  modSets: {
    create: invoke('modsets:create'),
    rename: invoke('modsets:rename'),
    remove: invoke('modsets:delete'),
    apply: invoke('modsets:apply'),
  },
  modrinth: { search: invoke('modrinth:search'), project: invoke('modrinth:project'), versions: invoke('modrinth:versions') },
  modpacks: {
    install: invoke('modpacks:install'),
    import: invoke('modpacks:import'),
    checkUpdate: invoke('modpacks:checkUpdate'),
    update: invoke('modpacks:update'),
    export: invoke('instances:export'),
    onTask: listen('task:progress'),
    cancelTask: invoke('task:cancel'),
  },
  importer: {
    scanInstances: invoke('import:scanInstances'),
    pickInstances: invoke('import:pickInstances'),
    instance: invoke('import:instance'),
  },
  crashes: {
    list: invoke('crashes:list'),
    read: invoke('crashes:read'),
    share: invoke('crashes:share'),
    open: invoke('crashes:open'),
    openFolder: invoke('crashes:openFolder'),
  },
  ui: { get: invoke('ui:get'), set: invoke('ui:set'), onLaunchRequest: listen('app:launchRequest') },
  versions: { list: invoke('versions:list'), details: invoke('versions:details'), loaders: invoke('loaders:available') },
  instances: {
    list: invoke('instances:list'),
    create: invoke('instances:create'),
    update: invoke('instances:update'),
    duplicate: invoke('instances:duplicate'),
    pickBackground: invoke('instances:pickBackground'),
    cleanBackground: invoke('instances:cleanBackground'),
    remove: invoke('instances:delete'),
    shortcut: invoke('instances:shortcut'),
    openFolder: invoke('instances:openFolder'),
  },
  accounts: {
    list: invoke('accounts:list'),
    addOffline: invoke('accounts:addOffline'),
    addMicrosoft: invoke('accounts:addMicrosoft'),
    remove: invoke('accounts:remove'),
    setActive: invoke('accounts:setActive'),
    refreshLooks: invoke('accounts:refreshLooks'),
  },
  skins: {
    state: invoke('skins:state'),
    library: invoke('skins:library'),
    import: invoke('skins:import'),
    copyPlayer: invoke('skins:copyPlayer'),
    setVariant: invoke('skins:setVariant'),
    remove: invoke('skins:remove'),
    apply: invoke('skins:apply'),
    reset: invoke('skins:reset'),
  },
  settings: { get: invoke('settings:get'), update: invoke('settings:update') },
  launcher: { get: invoke('launcher:get'), set: invoke('launcher:set'), discordStatus: invoke('discord:status') },
  java: {
    runtimes: invoke('java:runtimes'),
    system: invoke('java:system'),
    removeRuntime: invoke('java:removeRuntime'),
    openRuntime: invoke('java:openRuntime'),
  },
  perf: {
    preview: invoke('perf:preview'),
    ramGuide: invoke('perf:ramGuide'),
    pack: invoke('perf:pack'),
    installPack: invoke('perf:installPack'),
    metrics: invoke('perf:metrics'),
    gpuStatus: invoke('gpu:status'),
    setGpu: invoke('gpu:set'),
  },
  profiles: { plan: invoke('profiles:plan'), create: invoke('profiles:create'), installMods: invoke('profiles:installMods') },
  storage: { usage: invoke('storage:usage'), plan: invoke('storage:plan'), clean: invoke('storage:clean') },
  launch: {
    start: invoke('launch:start'),
    stop: invoke('launch:stop'),
    state: invoke('launch:state'),
    onStatus: listen('launch:status'),
    onProgress: listen('launch:progress'),
    onLogs: listen('launch:logs'),
    onReset: listen('launch:reset'),
  },
});
