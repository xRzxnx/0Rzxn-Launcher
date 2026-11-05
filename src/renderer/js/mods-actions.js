// Actions de l'onglet Mods : contenu installé, recherche Modrinth, installation, mises à jour.
import { refreshInstances } from './actions.js';
import { api } from './api.js';
import { forgetRamGuide, selectedInstance, state, toast, toastError, update } from './state.js';

export const KIND_LABELS = { mods: 'Mods', resourcepacks: 'Packs de ressources', shaders: 'Shaders', modpacks: 'Modpacks' };
const SINGULAR = { mods: 'mod', resourcepacks: 'pack de ressources', shaders: 'shader' };

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
      toast({ title: `${title || 'Ce contenu'} est déjà installé` });
    } else {
      toast({
        kind: 'success',
        title: `${main?.title ?? title} installé`,
        text: deps.length ? `Avec ${deps.map((d) => d.title).join(', ')} (dépendance${deps.length > 1 ? 's' : ''} obligatoire${deps.length > 1 ? 's' : ''}).` : `Version ${main?.version ?? ''}`,
      });
    }
    if (result.missingDependencies) {
      toast({ kind: 'error', title: 'Dépendance introuvable', text: `${result.missingDependencies} dépendance(s) n'existent pas pour cette version : le mod risque de ne pas démarrer.` });
    }
  } catch (error) {
    toastError('Installation impossible', error);
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
    toastError('Action impossible', error);
  } finally {
    setBusy(item.file, false);
  }
}

export async function deleteItem(instance, item) {
  setBusy(item.file, true);
  try {
    await api.deleteContent(instance.id, state.mods.kind, item.file);
    await refreshInstalled(instance);
    toast({ kind: 'success', title: `${item.title ?? item.name} supprimé`, text: 'Le fichier est dans la corbeille de Windows.' });
  } catch (error) {
    toastError('Suppression impossible', error);
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
    toast({ kind: 'success', title: updated.length > 1 ? `${updated.length} mises à jour installées` : 'Mise à jour installée', text: updated.map((u) => `${u.title} ${u.version}`).join(', ') });
  } catch (error) {
    toastError('Mise à jour impossible', error);
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
    if (copied.length) toast({ kind: 'success', title: `${copied.length} fichier${copied.length > 1 ? 's' : ''} ajouté${copied.length > 1 ? 's' : ''}`, text: copied.join(', ') });
    else toast({ kind: 'error', title: 'Rien à ajouter', text: `Glisse des fichiers ${kind === 'mods' ? '.jar' : '.zip'} pour ajouter un ${SINGULAR[kind]}.` });
  } catch (error) {
    toastError('Ajout impossible', error);
  }
}

export function openContentFolder(instance) {
  api.openContentFolder(instance.id, state.mods.kind).catch((error) => toastError("Impossible d'ouvrir le dossier", error));
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
    text: `Nouvelle instance : Minecraft ${instance.version}${instance.loader !== 'vanilla' ? ` · ${instance.loader}` : ''}. Le premier lancement installe le loader.`,
  });
}

export async function installModpack(hit, versionId = null) {
  setBusy(hit.id, true);
  try {
    await afterModpack(api.installModpack(hit.id, versionId, { title: hit.title, icon: hit.icon }), 'installé');
  } catch (error) {
    toastError('Installation du modpack impossible', error);
  } finally {
    setBusy(hit.id, false);
  }
}

export async function importModpack() {
  try {
    await afterModpack(api.importModpack(), 'importé');
  } catch (error) {
    toastError('Import impossible', error);
  }
}

export async function checkModpackUpdate(instance) {
  update((s) => { s.modpackUpdates[instance.id] = { checking: true }; });
  try {
    const next = await api.checkModpackUpdate(instance.id);
    update((s) => { s.modpackUpdates[instance.id] = next ?? { none: true }; });
    if (!next) toast({ title: `${instance.modpack.name} est à jour`, text: `Version ${instance.modpack.version}` });
  } catch (error) {
    update((s) => { delete s.modpackUpdates[instance.id]; });
    toastError('Vérification impossible', error);
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
      title: `${result.instance.modpack.name} mis à jour`,
      text: `Version ${result.instance.modpack.version} · ${result.files} fichiers${result.removed ? `, ${result.removed} retirés (corbeille)` : ''}. Tes réglages et tes mondes sont conservés.`,
    });
  } catch (error) {
    toastError('Mise à jour du modpack impossible', error);
  }
}

export async function exportInstance(instance, options) {
  const result = await api.exportInstance(instance.id, options);
  if (!result) return false; // enregistrement annulé
  toast({
    kind: 'success',
    title: 'Modpack exporté',
    text: `${result.file} · ${result.referenced} fichiers téléchargés depuis Modrinth, ${result.embedded} inclus dans le pack.`,
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
        title: 'Bascule incomplète',
        text: `${result.failed.length} mod${result.failed.length > 1 ? 's' : ''} n'ont pas pu changer d'état (${result.failed.slice(0, 3).map((f) => f.file).join(', ')}). Ferme ce qui les utilise et réessaie.`,
        timeout: 12000,
      });
    }
  } catch (error) {
    toastError('Changement d’ensemble impossible', error);
  } finally {
    await afterSetChange(instance).catch(() => {});
    setBusy('*sets*', false);
  }
}
