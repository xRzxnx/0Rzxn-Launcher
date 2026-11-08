// Actions de l'onglet Mondes : liste, sauvegardes .zip, restauration, mise à la corbeille.
import { api } from './api.js';
import { requestLaunch } from './actions.js';
import { formatSize } from './dom.js';
import { num, t } from './i18n.js';
import { state, toast, toastError, update } from './state.js';

// Annulation demandée par le bouton « Annuler » : l'erreur qui suit n'est pas un échec.
let cancelRequested = false;

/** Mondes et sauvegardes de l'instance (chargés à la demande). */
export function instanceWorlds(instance) {
  if (!state.worlds.lists[instance.id]) refreshWorlds(instance);
  return state.worlds.lists[instance.id];
}

export async function refreshWorlds(instance) {
  state.worlds.lists[instance.id] = { ...(state.worlds.lists[instance.id] ?? {}), loading: true };
  try {
    const data = await api.worlds(instance.id);
    update((s) => { s.worlds.lists[instance.id] = { ...data, loading: false }; });
  } catch (error) {
    update((s) => { s.worlds.lists[instance.id] = { worlds: [], backups: [], loading: false, error: error.message }; });
  }
}

/** La liste sera relue au prochain affichage (après une sauvegarde automatique, par exemple). */
export function forgetWorlds(instanceId) {
  delete state.worlds.lists[instanceId];
}

export const busyKey = (instance, folder) => `${instance.id}:${folder}`;

export function selectWorld(instance, folder) {
  update((s) => { s.worlds.selected[instance.id] = folder; });
}

export function setWorldsView(patch) {
  update((s) => { Object.assign(s.worlds, patch); });
}

export function cancelWorldTask() {
  cancelRequested = true;
  api.cancelTask().catch(() => {});
}

async function guarded(key, kind, work, failTitle) {
  cancelRequested = false;
  update((s) => { s.worlds.busy[key] = kind; });
  try {
    return await work();
  } catch (error) {
    if (cancelRequested) toast({ title: t('worlds.annule'), text: t('worlds.rien_a_change') });
    else toastError(failTitle, error);
    return null;
  } finally {
    cancelRequested = false;
    update((s) => { delete s.worlds.busy[key]; });
  }
}

export async function backupWorld(instance, world) {
  const result = await guarded(busyKey(instance, world.folder), 'backup', () => api.backupWorld(instance.id, world.folder), t('worlds.sauvegarde_impossible'));
  if (result) {
    toast({
      kind: 'success',
      title: t('worlds.sauvegarde_de', { name: world.name }),
      text: t('worlds.taille_fichiers', { size: formatSize(result.size), files: num(result.files) }),
    });
  }
  await refreshWorlds(instance);
}

export function askRestore(instance, world, backup) {
  update((s) => { s.modal = { type: 'restore-world', instanceId: instance.id, folder: world.folder, name: world.name, backup, mode: 'beside' }; });
}

export async function runRestore(modal) {
  const instance = state.instances.find((i) => i.id === modal.instanceId);
  if (!instance) return;
  update((s) => { s.modal = null; });
  const result = await guarded(busyKey(instance, modal.folder), 'restore', () => api.restoreWorld(instance.id, modal.backup.file, modal.mode), t('worlds.restauration_impossible'));
  if (result) {
    toast({
      kind: 'success',
      title: t('worlds.restaure', { name: result.name }),
      text: result.replaced ? t('worlds.ancien_monde_corbeille') : t('worlds.restaure_dans', { folder: result.folder }),
    });
    update((s) => { s.worlds.selected[instance.id] = result.folder; });
  }
  await refreshWorlds(instance);
}

export function askDeleteWorld(instance, world) {
  update((s) => { s.modal = { type: 'delete-world', instanceId: instance.id, folder: world.folder, name: world.name }; });
}

export async function deleteWorld(modal) {
  const instance = state.instances.find((i) => i.id === modal.instanceId);
  if (!instance) return;
  update((s) => { s.modal = null; });
  try {
    await api.deleteWorld(instance.id, modal.folder);
    toast({ kind: 'success', title: t('worlds.supprime', { name: modal.name }), text: t('worlds.dans_la_corbeille') });
  } catch (error) {
    toastError(t('worlds.suppression_impossible'), error);
  }
  await refreshWorlds(instance);
}

export async function deleteBackup(instance, backup) {
  try {
    await api.deleteWorldBackup(instance.id, backup.file);
    toast({ kind: 'success', title: t('worlds.sauvegarde_supprimee'), text: t('worlds.dans_la_corbeille') });
  } catch (error) {
    toastError(t('worlds.suppression_impossible'), error);
  }
  await refreshWorlds(instance);
}

export function openWorldsFolder(instance, folder) {
  api.openWorldFolder(instance.id, folder ?? null).catch((error) => toastError(t('worlds.dossier_impossible'), error));
}

/** Lance l'instance et entre directement dans ce monde (Quick Play). */
export function playWorld(instance, world) {
  update((s) => { s.selectedId = instance.id; });
  requestLaunch({ quickPlay: { type: 'singleplayer', id: world.folder, name: world.name } });
}
