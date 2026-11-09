'use strict';

// Rapports de crash de toutes les instances : liste avec le type d'erreur reconnu, lecture expliquée, partage.
const { currentLanguage } = require('../i18n');
const crashes = require('../core/crashes');
const versions = require('../core/versions');

const text = (value) => (typeof value === 'string' ? value : '');

function createCrashService({ dirs, instances }) {
  const crashDirs = (id) => {
    const instance = instances.get(text(id));
    return { instance, gameDir: instances.gameDir(instance.id), instanceDir: instances.dir(instance.id) };
  };
  const summaries = new Map(); // « chemin:date » → type d'erreur reconnu, pour la liste
  const crashPath = (id, source, file) => crashes.crashFile(crashDirs(id), text(source), text(file));

  return {
    crashDirs,
    crashPath,
    async list() {
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
    },
    async read(id, source, file) {
      const { instance } = crashDirs(id);
      const report = await crashes.readCrashText(crashPath(id, source, file));
      const java = instance.settings.java === 'custom' ? null : await versions.versionDetails(dirs, instance.version).then((d) => d.java, () => null);
      return { ...report, ...crashes.diagnose(report.text, { java, ram: instance.settings.ram, javaMode: instance.settings.java }) };
    },
    share: async (id, source, file) => crashes.shareLog((await crashes.readCrashText(crashPath(id, source, file))).text),
  };
}

module.exports = { createCrashService };
