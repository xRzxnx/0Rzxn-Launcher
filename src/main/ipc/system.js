'use strict';

// Java, performances, profils prêts à jouer, carte graphique et espace disque.
const { t } = require('../i18n');
const storage = require('../core/storage');
const { createSystemService } = require('../services/system');
const { openDir, text } = require('./handle');

function register(ctx) {
  const { handle, dirs, instances, notRunning, notBusy } = ctx;
  const system = createSystemService(ctx);

  // ---------- Java ----------
  handle('java:runtimes', () => storage.runtimesWithUsage(dirs, instances.list()));
  handle('java:system', (refresh) => system.systemJavas(refresh));
  handle('java:removeRuntime', (component) => {
    notBusy(t('ipc.supprimer_un_java'));
    return system.removeRuntime(component);
  });
  handle('java:openRuntime', (component) => openDir(system.runtimeDir(component)));

  // ---------- Performances ----------
  handle('perf:ramGuide', (id, settings) => system.ramGuide(id, settings));
  handle('perf:preview', (id, settings) => system.preview(id, settings));
  handle('perf:pack', (id) => system.pack(id));
  handle('perf:installPack', (id, slugs, options) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    return system.installPack(id, slugs, options);
  });
  handle('perf:metrics', () => system.metrics());
  handle('gpu:status', () => system.gpuStatus());
  handle('gpu:set', (on) => system.setGpu(on));

  // ---------- Assistant de création : profils prêts à jouer ----------
  handle('profiles:plan', (profileId, version) => system.profilePlan(profileId, version));
  handle('profiles:create', (data) => system.profileCreate(data));
  handle('profiles:installMods', (id, profileId) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    return system.profileInstallMods(id, profileId);
  });

  // ---------- Espace disque ----------
  handle('storage:usage', () => storage.usage(dirs));
  handle('storage:plan', async () => (await storage.cleanupPlan(dirs, instances.list())).map(({ paths, ...item }) => item));
  handle('storage:clean', (ids) => {
    notBusy(t('ipc.liberer_de_espace'));
    return storage.clean(dirs, instances.list(), Array.isArray(ids) ? ids.map(text) : []);
  });
}

module.exports = { register };
