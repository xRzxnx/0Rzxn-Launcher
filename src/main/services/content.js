'use strict';

// Contenu des instances (mods, packs de ressources, shaders), ensembles de mods, dépendances, menu titre et Modrinth.
const content = require('../core/content');
const modCheck = require('../core/mod-check');
const modDeps = require('../core/mod-deps');
const modSets = require('../core/mod-sets');
const modrinth = require('../core/modrinth');
const titleMenu = require('../core/title-menu');

const text = (value) => (typeof value === 'string' ? value : '');

/** `trash` : corbeille de Windows. */
function createContentService({ instances, trash }) {
  const contentCtx = (id, kind) => {
    const instance = instances.get(text(id));
    content.contentDir(instances.gameDir(instance.id), text(kind)); // valide le type
    return { instance, gameDir: instances.gameDir(instance.id), kind: text(kind) };
  };
  // Mods dont le jar annonce une autre version de Minecraft (d'après le diagnostic).
  const mismatchedJars = async (gameDir, instance) => {
    try {
      const { problems } = await modCheck.check({ gameDir, instance });
      return new Set(problems.filter((p) => p.id.startsWith('mc:')).map((p) => p.id.slice(3)));
    } catch {
      return new Set();
    }
  };
  // Après un changement du dossier des mods, l'ensemble actif suit (nouveau mod, interrupteur, suppression).
  const setsCtx = (id) => {
    const instance = instances.get(text(id));
    return { store: instances, instance, gameDir: instances.gameDir(instance.id) };
  };
  const syncSets = (id) => modSets.sync(setsCtx(id)).catch(() => {});
  // Installe ce que les mods de l'instance réclament, d'où qu'ils viennent.
  const resolveDeps = async (id) => {
    const ctx = contentCtx(id, 'mods');
    const result = await modDeps.resolve({ gameDir: ctx.gameDir, instance: ctx.instance, trash });
    if (result.installed.length) await syncSets(id);
    return result;
  };

  // ---------- Écran titre du jeu (menu Cristal) ----------
  const titleStatus = (id) => {
    const ctx = contentCtx(id, 'mods');
    const versions = () => modrinth.versions(titleMenu.FANCYMENU, { loaders: content.loadersFor('mods', ctx.instance), gameVersion: ctx.instance.version });
    return titleMenu.status({ gameDir: ctx.gameDir, instance: ctx.instance, versions });
  };
  const applyTitleMenu = async (id, options, before) => {
    const ctx = contentCtx(id, 'mods');
    if (!before.installed) {
      await content.install({ ...ctx, projectId: titleMenu.FANCYMENU, trash });
      await syncSets(id);
    }
    const instance = instances.update(text(id), { titleMenu: options ?? {} });
    await titleMenu.refresh({ gameDir: ctx.gameDir, instance });
  };
  // Version sans FancyMenu : retenue jusqu'à la fermeture du launcher, pour ne pas redemander à chaque partie.
  const titleUnavailable = new Map();

  return {
    contentCtx,
    syncSets,
    resolveDeps,

    // Chaque fichier dit s'il est prévu pour la version de l'instance : versions listées sur Modrinth, ou plage du jar.
    async list(id, kind) {
      const ctx = contentCtx(id, kind);
      const data = await content.listContent(ctx);
      const flagged = ctx.kind === 'mods' ? await mismatchedJars(ctx.gameDir, ctx.instance) : new Set();
      for (const item of data.items) {
        const unlisted = Array.isArray(item.gameVersions) && item.gameVersions.length > 0 && !item.gameVersions.includes(ctx.instance.version);
        item.incompatible = flagged.has(item.file) || unlisted;
      }
      return data;
    },
    async versionPlan(id, target) {
      const instance = instances.get(text(id));
      const gameDir = instances.gameDir(instance.id);
      const version = text(target);
      const localMismatch = await mismatchedJars(gameDir, { ...instance, version });
      return content.versionPlan({ gameDir, instance, target: version, localMismatch });
    },
    async toggle(id, kind, file) {
      await content.toggle({ ...contentCtx(id, kind), file: text(file) });
      if (text(kind) === 'mods') await syncSets(id);
    },
    async remove(id, kind, file) {
      const ctx = contentCtx(id, kind);
      await trash(content.safePath(content.contentDir(ctx.gameDir, ctx.kind), text(file)));
      if (ctx.kind === 'mods') await syncSets(id);
    },
    async install(id, kind, projectId, versionId) {
      const result = await content.install({ ...contentCtx(id, kind), projectId: text(projectId), versionId: text(versionId) || null, trash });
      if (text(kind) !== 'mods') return result;
      await syncSets(id);
      // Le jar peut réclamer plus que ce que sa page Modrinth annonce.
      const extra = await resolveDeps(id).catch(() => null);
      return {
        installed: [...result.installed, ...(extra?.installed ?? [])],
        missingDependencies: Math.max(result.missingDependencies, extra?.unresolved.length ?? 0),
      };
    },
    async update(id, kind, files) {
      const result = await content.update({ ...contentCtx(id, kind), files: Array.isArray(files) ? files.map(text) : null, trash });
      if (text(kind) === 'mods') await syncSets(id);
      return result;
    },
    async importFiles(id, kind, paths) {
      const result = await content.importFiles({ ...contentCtx(id, kind), paths: Array.isArray(paths) ? paths.map(text) : [] });
      if (text(kind) === 'mods') await syncSets(id);
      return result;
    },
    folder(id, kind) {
      const ctx = contentCtx(id, kind);
      return content.contentDir(ctx.gameDir, ctx.kind);
    },
    check(id) {
      const ctx = contentCtx(id, 'mods');
      return modCheck.check({ gameDir: ctx.gameDir, instance: ctx.instance });
    },

    // ---------- Ensembles de mods ----------
    createSet: (id, name) => modSets.create({ ...setsCtx(id), name: text(name) }),
    renameSet: (id, setId, name) => modSets.rename({ ...setsCtx(id), setId: text(setId), name: text(name) }),
    removeSet: (id, setId) => modSets.remove({ ...setsCtx(id), setId: text(setId) }),
    applySet: (id, setId) => modSets.apply({ ...setsCtx(id), setId: setId == null ? null : text(setId) }),

    // ---------- Menu titre ----------
    titleStatus,
    async titleApply(id, options) {
      await applyTitleMenu(id, options, await titleStatus(id));
      return titleStatus(id);
    },
    // Avant chaque lancement : une instance moddée jamais réglée reçoit le menu Cristal.
    async titleAuto(id, options) {
      const { instance } = contentCtx(id, 'mods');
      const key = `${instance.version}/${instance.loader}`;
      if (!titleMenu.wantsAuto(instance) || titleUnavailable.get(instance.id) === key) return { added: false };
      const before = await titleStatus(id);
      if (before.available === false) titleUnavailable.set(instance.id, key);
      // Mod connu pour planter avec FancyMenu, ou Modrinth injoignable : on réessaiera au prochain lancement.
      if (!before.available || before.conflicts.length) return { added: false };
      await applyTitleMenu(id, options ?? {}, before);
      return { added: true, installed: !before.installed };
    },
    async titleDisable(id) {
      await titleMenu.removeMenu(contentCtx(id, 'mods').gameDir);
      instances.update(text(id), { titleMenu: null });
      return titleStatus(id);
    },

    // ---------- Modrinth ----------
    search({ instanceId, kind, query, sort, offset } = {}) {
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
    },
    project: (projectId) => modrinth.project(text(projectId)),
    versions(projectId, instanceId, kind) {
      if (kind === 'modpacks') return modrinth.versions(text(projectId), {});
      const { instance } = contentCtx(instanceId, kind);
      return modrinth.versions(text(projectId), { loaders: content.loadersFor(kind, instance), gameVersion: instance.version });
    },
  };
}

module.exports = { createContentService };
