// Actions de l'onglet Mondes : liste, sauvegardes .zip, restauration, mise à la corbeille.
import { api } from './api.js';
import { formatSize } from './dom.js';
import { state, toast, toastError, update } from './state.js';

const cancelled = (error) => /annulée/.test(error?.message ?? '');

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

/** La liste sera relue au prochain affichage (après un import de monde, par exemple). */
export function forgetWorlds(instanceId) {
  delete state.worlds.lists[instanceId];
}

export const busyKey = (instance, folder) => `${instance.id}:${folder}`;

export async function backupWorld(instance, world) {
  const key = busyKey(instance, world.folder);
  update((s) => { s.worlds.busy[key] = 'backup'; });
  try {
    const result = await api.backupWorld(instance.id, world.folder);
    toast({
      kind: 'success',
      title: `${world.name} sauvegardé`,
      text: `${formatSize(result.size)} · ${result.files.toLocaleString('fr-FR')} fichiers.`,
      actions: [{ label: 'Ouvrir le dossier', run: () => openBackups(instance) }],
    });
  } catch (error) {
    if (cancelled(error)) toast({ title: 'Sauvegarde annulée' });
    else toastError('Sauvegarde impossible', error);
  } finally {
    update((s) => { delete s.worlds.busy[key]; });
    await refreshWorlds(instance);
  }
}

export function cancelTask() {
  api.cancelTask().catch(() => {});
}

/** source : { backup: fichier } (sauvegarde du launcher) ou { file: chemin } (choisi dans Windows). */
export async function restoreFrom(instance, source) {
  try {
    const info = await api.inspectWorldZip(instance.id, source);
    if (info.taken) {
      update((s) => { s.modal = { type: 'restore-world', instanceId: instance.id, source, folder: info.folder }; });
      return;
    }
    await runRestore(instance, source, null);
  } catch (error) {
    toastError('Restauration impossible', error);
  }
}

export async function runRestore(instance, source, mode) {
  update((s) => {
    if (s.modal?.type === 'restore-world') s.modal = null;
  });
  try {
    const result = await api.restoreWorld(instance.id, source, mode);
    toast({
      kind: 'success',
      title: `${result.name} restauré`,
      text: result.replaced ? `L’ancienne version de « ${result.folder} » est dans la corbeille de Windows.` : `Dans saves\\${result.folder}.`,
    });
  } catch (error) {
    if (cancelled(error)) toast({ title: 'Restauration annulée', text: 'Rien n’a été modifié.' });
    else toastError('Restauration impossible', error);
  } finally {
    await refreshWorlds(instance);
  }
}

export async function pickAndRestore(instance) {
  try {
    const picked = await api.pickWorldZip();
    if (picked) await restoreFrom(instance, { file: picked.file });
  } catch (error) {
    toastError('Restauration impossible', error);
  }
}

export function askDeleteWorld(instance, world) {
  update((s) => { s.modal = { type: 'delete-world', instanceId: instance.id, folder: world.folder, name: world.name }; });
}

export async function deleteWorld(instance, folder, name) {
  await api.deleteWorld(instance.id, folder);
  update((s) => { s.modal = null; });
  toast({ kind: 'success', title: `${name} supprimé`, text: 'Le monde est dans la corbeille de Windows si tu changes d’avis.' });
  await refreshWorlds(instance);
}

export async function deleteBackup(instance, backup) {
  try {
    await api.deleteBackup(instance.id, backup.file);
    toast({ kind: 'success', title: 'Sauvegarde supprimée', text: `${backup.file} est dans la corbeille de Windows.` });
  } catch (error) {
    toastError('Suppression impossible', error);
  }
  await refreshWorlds(instance);
}

export function openWorldsFolder(instance, folder) {
  api.openWorldsFolder(instance.id, folder ?? null).catch((error) => toastError("Impossible d'ouvrir le dossier", error));
}

export function openBackups(instance) {
  api.openBackupsFolder(instance.id).catch((error) => toastError("Impossible d'ouvrir le dossier", error));
}
