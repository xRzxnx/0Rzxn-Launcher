// Actions de l'onglet Mods : contenu installé, recherche Modrinth, installation, mises à jour.
import { t } from './i18n.js';
import { installMissingDeps, refreshInstances } from './actions.js';
import { api } from './api.js';
import { forgetRamGuide, selectedInstance, state, toast, toastError, update } from './state.js';

export const KIND_LABELS = { mods: 'Mods', get resourcepacks() { return t('mods.packs_de_ressources'); }, shaders: 'Shaders', modpacks: 'Modpacks' };
const SINGULAR = { mods: 'mod', get resourcepacks() { return t('mods.pack_de_ressources'); }, shaders: 'shader' };

const keyOf = (instance, kind) => `${instance.id}:${kind}`;

/** Contenu installé (chargé à la demande, puis gardé jusqu'au prochain changement). */
export function installedContent(instance, kind = state.mods.kind) {
  const key = keyOf(instance, kind);
  const known = state.mods.installed[key];
  if (!known) refreshInstalled(instance, kind);
  return state.mods.installed[key];
}

export async function refreshInstalled(instance = selectedInstance(), kind = state.mods.kind) {
  if (!instance) return;
  const key = keyOf(instance, kind);
  state.mods.installed[key] = { ...(state.mods.installed[key] ?? {}), loading: true };
  try {
    const data = await api.content(instance.id, kind);
    forgetRamGuide(instance.id);
    update((s) => { s.mods.installed[key] = { ...data, loading: false }; });
  } catch (error) {
    update((s) => { s.mods.installed[key] = { items: [], loading: false, error: error.message }; });
  }
}

/** Mods dont une version plus récente existe (d'après le dernier contrôle, sans rien charger). */
export function pendingModUpdates(instance) {
  if (!instance || instance.loader === 'vanilla') return [];
  return (state.mods.installed[keyOf(instance, 'mods')]?.items ?? []).filter((item) => item.update);
}

let backgroundDone = false;

/** Une fois par démarrage : vérifie les autres instances moddées, une à la fois, sans bruit. */
export async function checkOtherInstances() {
  if (backgroundDone) return;
  backgroundDone = true;
  for (const instance of [...state.instances]) {
    if (state.versions.offline) return;
    if (instance.id === state.selectedId || instance.loader === 'vanilla' || state.mods.installed[keyOf(instance, 'mods')]) continue;
    await refreshInstalled(instance, 'mods').catch(() => {});
  }
}

function setBusy(id, value) {
  update((s) => {
    if (value) s.mods.busy[id] = true;
    else delete s.mods.busy[id];
  });
}

export function setModsView(patch) {
  update((s) => {
    Object.assign(s.mods, patch);
    if ('kind' in patch) {
      s.mods.selected = null;
      s.mods.search.key = null;
    }
  });
}

// ---------- Recherche Modrinth ----------

let searchTimer = null;
let searchSeq = 0;

/** Clé de la recherche affichée : quand elle change, on relance la recherche. */
export function searchKey(instance) {
  const scope = state.mods.kind === 'modpacks' ? 'tous' : `${instance.id}|${instance.version}|${instance.loader}`;
  return `${scope}|${state.mods.kind}|${state.mods.sort}|${state.mods.query.trim()}`;
}

export function runSearch(instance, { more = false, delay = 0 } = {}) {
  clearTimeout(searchTimer);
  const key = searchKey(instance);
  const offset = more ? state.mods.search.hits.length : 0;
  state.mods.search = more ? { ...state.mods.search, loading: true } : { key, loading: true, hits: [], total: 0, error: null };
  const seq = ++searchSeq;
  searchTimer = setTimeout(async () => {
    try {
      const data = await api.searchModrinth({ instanceId: instance?.id, kind: state.mods.kind, query: state.mods.query, sort: state.mods.sort, offset });
      if (seq !== searchSeq) return; // une recherche plus récente a été lancée
      update((s) => {
        s.mods.search = { key, loading: false, error: null, total: data.total, hits: more ? [...s.mods.search.hits, ...data.hits] : data.hits };
        if (!more && !data.hits.some((h) => h.id === s.mods.selected)) s.mods.selected = data.hits[0]?.id ?? null;
      });
    } catch (error) {
      if (seq === searchSeq) update((s) => { s.mods.search = { key, loading: false, hits: [], total: 0, error: error.message }; });
    }
  }, delay);
}

export function projectDetails(id) {
  const known = state.mods.projects[id];
  if (known) return known.loading || known.error ? null : known;
  state.mods.projects[id] = { loading: true };
  api.modrinthProject(id).then(
    (p) => update((s) => { s.mods.projects[id] = p; }),
    (error) => update((s) => { s.mods.projects[id] = { error: error.message }; }),
  );
  return null;
}

export function projectVersions(projectId, instance) {
  const key = `${projectId}:${instance?.id ?? '-'}:${state.mods.kind}`;
  const known = state.mods.versions[key];
  if (known) return Array.isArray(known) ? known : null;
  state.mods.versions[key] = { loading: true };
  api.modrinthVersions(projectId, instance?.id, state.mods.kind).then(
    (list) => update((s) => { s.mods.versions[key] = list; }),
    (error) => update((s) => { s.mods.versions[key] = { error: error.message }; }),
  );
  return null;
}

// ---------- Actions sur le contenu ----------

export async function installProject(instance, projectId, versionId = null, title = '') {
  const kind = state.mods.kind;
  setBusy(projectId, true);
  try {
    const result = await api.installContent(instance.id, kind, projectId, versionId);
    await refreshInstalled(instance, kind);
    const main = result.installed.find((d) => !d.dependency);
    const deps = result.installed.filter((d) => d.dependency);
    if (!main && !deps.length) {
      toast({ title: t('common.est_deja_installe', { title: title || t('mods.ce_contenu') }) });
    } else {
      toast({
        kind: 'success',
        title: t('mods.installe', { title: main?.title ?? title }),
        text: deps.length ? t('mods.with_deps', { count: deps.length, deps: deps.map((d) => d.title).join(', ') }) : t('mods.version', { version: main?.version ?? '' }),
      });
    }
    if (result.missingDependencies) {
      toast({ kind: 'error', title: t('mods.dependance_introuvable'), text: t('mods.deps_missing', { count: result.missingDependencies }) });
    }
  } catch (error) {
    toastError(t('common.installation_impossible'), error);
  } finally {
    setBusy(projectId, false);
  }
}

export async function toggleItem(instance, item) {
  setBusy(item.file, true);
  try {
    await api.toggleContent(instance.id, state.mods.kind, item.file);
    await refreshInstalled(instance);
  } catch (error) {
    toastError(t('common.action_impossible'), error);
  } finally {
    setBusy(item.file, false);
  }
}

export async function deleteItem(instance, item) {
  setBusy(item.file, true);
  try {
    await api.deleteContent(instance.id, state.mods.kind, item.file);
    await refreshInstalled(instance);
    toast({ kind: 'success', title: t('mods.supprime', { title: item.title ?? item.name }), text: t('mods.le_fichier_est_dans_la') });
  } catch (error) {
    toastError(t('common.suppression_impossible'), error);
  } finally {
    setBusy(item.file, false);
  }
}

export async function updateItems(instance, files = null, kind = state.mods.kind) {
  const id = files ? files[0] : '*update-all*';
  setBusy(id, true);
  try {
    const updated = await api.updateContent(instance.id, kind, files);
    await refreshInstalled(instance, kind);
    toast({ kind: 'success', title: updated.length > 1 ? t('mods.mises_jour_installees', { updated: updated.length }) : t('mods.mise_jour_installee'), text: updated.map((u) => `${u.title} ${u.version}`).join(', ') });
  } catch (error) {
    toastError(t('mods.mise_jour_impossible'), error);
  } finally {
    setBusy(id, false);
  }
}

export async function importDropped(instance, files) {
  const kind = state.mods.kind;
  const paths = [...files].map((f) => api.filePath(f)).filter(Boolean);
  try {
    const copied = await api.importContent(instance.id, kind, paths);
    await refreshInstalled(instance, kind);
    if (copied.length) toast({ kind: 'success', title: t('mods.fichiers_ajoutes', { count: copied.length }), text: copied.join(', ') });
    else toast({ kind: 'error', title: t('mods.rien_ajouter'), text: t({ mods: 'mods.drop_add_mod', resourcepacks: 'mods.drop_add_pack', shaders: 'mods.drop_add_shader' }[kind]) });
    if (kind === 'mods' && copied.length) await completeDropped(instance);
  } catch (error) {
    toastError(t('mods.ajout_impossible'), error);
  }
}

/** Un mod glissé arrive sans ses dépendances : on les ajoute tout de suite. */
async function completeDropped(instance) {
  const { problems } = await api.checkMods(instance.id);
  if (!problems.some((p) => p.dependency)) return;
  const { unresolved } = await installMissingDeps(instance.id);
  await refreshInstalled(instance, 'mods');
  if (unresolved.length) toast({ kind: 'error', title: t('mods.dependance_introuvable'), text: t('mods.deps_missing', { count: unresolved.length }) });
}

export function openContentFolder(instance) {
  api.openContentFolder(instance.id, state.mods.kind).catch((error) => toastError(t('common.impossible_ouvrir_le_dossier'), error));
}

// ---------- Modpacks ----------

async function afterModpack(promise, verb) {
  const instance = await promise;
  if (!instance) return; // import annulé
  await refreshInstances();
  update((s) => {
    s.selectedId = instance.id;
    s.view = 'home';
  });
  toast({
    kind: 'success',
    title: `${instance.name} ${verb}`,
    text: t('mods.new_instance_text', { version: [instance.version, instance.loader !== 'vanilla' && instance.loader].filter(Boolean).join(' · ') }),
  });
}

export async function installModpack(hit, versionId = null) {
  setBusy(hit.id, true);
  try {
    await afterModpack(api.installModpack(hit.id, versionId, { title: hit.title, icon: hit.icon }), t('mods.installe_2'));
  } catch (error) {
    toastError(t('mods.installation_du_modpack_impossible'), error);
  } finally {
    setBusy(hit.id, false);
  }
}

export async function importModpack() {
  try {
    await afterModpack(api.importModpack(), t('mods.importe'));
  } catch (error) {
    toastError(t('common.import_impossible'), error);
  }
}

export async function checkModpackUpdate(instance) {
  update((s) => { s.modpackUpdates[instance.id] = { checking: true }; });
  try {
    const next = await api.checkModpackUpdate(instance.id);
    update((s) => { s.modpackUpdates[instance.id] = next ?? { none: true }; });
    if (!next) toast({ title: t('mods.est_jour', { name: instance.modpack.name }), text: t('mods.version', { version: instance.modpack.version }) });
  } catch (error) {
    update((s) => { delete s.modpackUpdates[instance.id]; });
    toastError(t('mods.verification_impossible'), error);
  }
}

export async function updateModpack(instance, versionId) {
  try {
    const result = await api.updateModpack(instance.id, versionId);
    await refreshInstances();
    update((s) => {
      delete s.modpackUpdates[instance.id];
      for (const key of Object.keys(s.mods.installed)) if (key.startsWith(`${instance.id}:`)) delete s.mods.installed[key];
    });
    toast({
      kind: 'success',
      title: t('mods.mis_jour', { name: result.instance.modpack.name }),
      text: t(result.removed ? 'mods.pack_updated_removed' : 'mods.pack_updated', { version: result.instance.modpack.version, files: result.files, removed: result.removed }),
    });
  } catch (error) {
    toastError(t('mods.mise_jour_du_modpack_impossible'), error);
  }
}

export async function exportInstance(instance, options) {
  const result = await api.exportInstance(instance.id, options);
  if (!result) return false; // enregistrement annulé
  toast({
    kind: 'success',
    title: t('mods.modpack_exporte'),
    text: t('mods.fichiers_telecharges_depuis_modrinth_inclus', { file: result.file, referenced: result.referenced, embedded: result.embedded }),
    timeout: 10000,
  });
  return true;
}

// ---------- Ensembles de mods ----------

/** Même identifiant stable que dans le processus principal (src/main/core/mod-sets.js). */
export const modStableId = (item) => (item.modId ? `m:${String(item.modId).toLowerCase()}` : `f:${item.file.replace(/\.disabled$/, '').toLowerCase()}`);

/** Mods d'un ensemble qui sont encore installés. */
export function modSetCount(set, items) {
  const ids = new Set(set.mods);
  return items.filter((i) => ids.has(modStableId(i))).length;
}

export function openModSetDialog(instance, set = null) {
  update((s) => { s.modal = { type: 'mod-set', instanceId: instance.id, setId: set?.id ?? null, name: set?.name ?? '' }; });
}

export function openModSetDelete(instance, set) {
  update((s) => { s.modal = { type: 'mod-set-delete', instanceId: instance.id, setId: set.id }; });
}

async function afterSetChange(instance) {
  await refreshInstances();
  await refreshInstalled(instance, 'mods');
}

export async function saveModSet(instance, setId, name) {
  if (setId) await api.renameModSet(instance.id, setId, name);
  else await api.createModSet(instance.id, name);
  await afterSetChange(instance);
  update((s) => { s.modal = null; });
}

export async function removeModSet(instance, setId) {
  await api.deleteModSet(instance.id, setId);
  await afterSetChange(instance);
  update((s) => { s.modal = null; });
}

/** Active un ensemble (ou tous les mods avec setId nul). Les échecs partiels sont signalés, l'état affiché est relu. */
export async function selectModSet(instance, setId) {
  if (state.mods.busy['*sets*']) return;
  setBusy('*sets*', true);
  try {
    const result = await api.applyModSet(instance.id, setId);
    if (result.failed.length) {
      toast({
        kind: 'error',
        title: t('mods.bascule_incomplete'),
        text: t('mods.mods_ont_pas_pu_changer', { count: result.failed.length, failed: result.failed.slice(0, 3).map((f) => f.file).join(', ') }),
        timeout: 12000,
      });
    }
  } catch (error) {
    toastError(t('mods.changement_ensemble_impossible'), error);
  } finally {
    await afterSetChange(instance).catch(() => {});
    setBusy('*sets*', false);
  }
}
