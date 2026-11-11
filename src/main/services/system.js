'use strict';

// Java, performances (conseil de mémoire, arguments Java, pack performances), profils prêts à jouer,
// carte graphique et consommation du launcher.
const { t } = require('../i18n');
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sanitizeSettings } = require('../core/instances');
const { availableLoaders } = require('../core/loaders');
const versions = require('../core/versions');
const storage = require('../core/storage');
const performance = require('../core/performance');
const profiles = require('../core/profiles');
const { gpu } = require('../platform');
const { readHardware } = require('../core/hardware');
const { findSystemJavas } = require('../core/java');

const text = (value) => (typeof value === 'string' ? value : '');

function createSystemService({ services, dirs, instances, launches, runTask, trash, optimizations }) {
  // ---------- Java ----------
  let systemJavas = null;
  const runtimeDir = (component) => {
    const name = text(component);
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(t('ipc.java_inconnu'));
    return path.join(dirs.runtime, name);
  };

  // ---------- Performances ----------
  const cpus = os.cpus().length;
  // Conseil de mémoire : charge de l'instance (mods, shaders, ZGC) et composants du PC.
  const ramAdvice = async (instance, gc, counts) => {
    const pc = await readHardware();
    const shaders = instance ? await performance.activeShaders({ gameDir: instances.gameDir(instance.id), instance }).catch(() => 0) : 0;
    const guide = performance.ramGuide({ loader: instance?.loader, version: instance?.version, mods: counts.mods, shaders, zgc: gc, totalGb: pc.totalGb, integrated: pc.integrated });
    return { ...guide, mods: counts.mods, shaders, pc: { summary: pc.summary, detail: pc.detail } };
  };

  // ---------- Assistant de création : profils prêts à jouer ----------
  const hasFabric = (mc) => availableLoaders(mc).then((l) => Boolean(l.fabric?.recommended), () => false);
  const profileRam = async (p, version) => {
    const pc = await readHardware();
    return performance.ramGuide({ loader: p.loader, version, mods: p.mods.length, shaders: p.shaders ? 1 : 0, totalGb: pc.totalGb, integrated: pc.integrated });
  };

  // Temps processeur cumulé des processus du launcher, comparé au relevé précédent (percentCPUUsage sous-estime beaucoup).
  let lastMetrics = null;

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

  return {
    runtimeDir,
    async systemJavas(refresh) {
      if (!systemJavas || refresh === true) systemJavas = await findSystemJavas(dirs);
      return systemJavas;
    },
    async removeRuntime(component) {
      const runtime = (await storage.runtimesWithUsage(dirs, instances.list())).find((r) => r.component === text(component));
      if (!runtime) throw new Error(t('ipc.ce_java_est_deja_supprime'));
      if (runtime.usedBy.length) throw new Error(t('ipc.ce_java_sert_encore', { usedBy: runtime.usedBy.join(', ') }));
      await fs.promises.rm(runtimeDir(component), { recursive: true, force: true });
      return runtime.size;
    },

    async ramGuide(id, settings) {
      const instance = id ? instances.get(text(id)) : null;
      const s = sanitizeSettings(settings ?? {}, instance?.settings ?? services.settings.defaults());
      const counts = instance ? await performance.packInstalledCount({ gameDir: instances.gameDir(instance.id), instance }).catch(() => ({ mods: 0 })) : { mods: 0 };
      return ramAdvice(instance, s.jvmPreset === 'zgc', counts);
    },
    async preview(id, settings) {
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
    },
    pack(id) {
      const instance = instances.get(text(id));
      return performance.packStatus({ gameDir: instances.gameDir(instance.id), instance });
    },
    async installPack(id, slugs, options) {
      let instance = instances.get(text(id));
      const list = Array.isArray(slugs) ? slugs.map(text) : [];
      // Instance vanilla : passage en Fabric (mondes et réglages gardés), comme « Modifier › Loader ».
      let fabricVersion = null;
      if (instance.loader === 'vanilla') {
        if (options?.convert !== true) throw new Error(t('ipc.cette_instance_est_vanilla_il'));
        const fabric = (await availableLoaders(instance.version)).fabric;
        if (!fabric?.recommended) throw new Error(t('ipc.fabric_existe_pas_pour_minecraft', { version: instance.version }));
        fabricVersion = fabric.recommended;
      }
      // Historique des optimisations : copie d'avant le pack (et d'avant le passage en Fabric).
      const noted = optimizations?.record(instance, 'perf-pack', { count: list.length, converted: Boolean(fabricVersion) }) ?? null;
      if (fabricVersion) instance = instances.update(instance.id, { loader: 'fabric', loaderVersion: fabricVersion });
      const result = await runTask(t('ipc.pack_performances'), (onProgress) =>
        performance.installPack({ gameDir: instances.gameDir(instance.id), instance, slugs: list, trash, onProgress }),
      { kind: 'perf-pack', instanceId: instance.id, params: { slugs: list, name: instance.name } });
      optimizations?.added(noted, result.installed.map((m) => `mods/${m.file}`));
      return { ...result, instance };
    },

    async profilePlan(profileId, version) {
      const p = profiles.profile(text(profileId));
      const listed = await versions.listVersions(dirs);
      const releases = listed.versions.filter((v) => v.type === 'release').map((v) => v.id);
      const result = await profiles.plan({ profileId: p.id, version: text(version) || null, releases, hasLoader: hasFabric });
      const guide = await profileRam(p, result.version);
      return { ...result, ram: { ideal: guide.ideal, low: guide.low, high: guide.high, limited: guide.limited } };
    },
    async profileCreate(data) {
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
    },
    profileInstallMods(id, profileId) {
      const instance = instances.get(text(id));
      const p = profiles.profile(text(profileId));
      const noted = optimizations?.record(instance, 'profile-mods', { profileId: p.id }) ?? null;
      return runTask(t('ipc.mods_du_profil', { title: p.title }), (onProgress) =>
        profiles.installMods({ profileId: p.id, gameDir: instances.gameDir(instance.id), instance, trash, onProgress }),
      { kind: 'profile-mods', instanceId: instance.id, params: { profileId: p.id, name: instance.name } }).then((result) => {
        optimizations?.added(noted, result.installed.map((m) => `mods/${m.file}`));
        return result;
      });
    },

    metrics() {
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
    },
    async gpuStatus() {
      const gpus = await gpu.listGpus().catch(() => []);
      const exes = javaExes();
      const prefs = await Promise.all(exes.map((exe) => gpu.preference(exe)));
      return { gpus, javas: exes.length, high: prefs.filter((p) => p === 'high').length, enabled: services.settings.launcher().gpuHighPerformance };
    },
    // Le réglage de Windows n'est écrit qu'après l'accord donné dans la fenêtre de confirmation.
    async setGpu(on) {
      const exes = javaExes();
      if (on === true) await gpu.setHighPerformance(exes);
      else await gpu.clearPreference(exes);
      return services.settings.setLauncher({ gpuHighPerformance: on === true });
    },
  };
}

module.exports = { createSystemService };
