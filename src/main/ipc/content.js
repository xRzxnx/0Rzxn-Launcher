'use strict';

// Contenu des instances (mods, packs, shaders), ensembles de mods, contrôle des mods, menu titre et Modrinth.
const { t } = require('../i18n');
const { openDir, text } = require('./handle');

function register({ handle, contents, notRunning }) {
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
  handle('content:update', (id, kind, files) => {
    notRunning(text(id), t('ipc.mettre_jour_son_contenu'));
    return contents.update(id, kind, files);
  });
  handle('content:import', (id, kind, paths) => {
    notRunning(text(id), t('ipc.modifier_son_contenu'));
    return contents.importFiles(id, kind, paths);
  });
  handle('content:openFolder', (id, kind) => openDir(contents.folder(id, kind)));

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

  // ---------- Modrinth ----------
  handle('modrinth:search', (params) => contents.search(params));
  handle('modrinth:project', (projectId) => contents.project(projectId));
  handle('modrinth:versions', (projectId, instanceId, kind) => contents.versions(projectId, instanceId, kind));
}

module.exports = { register };
