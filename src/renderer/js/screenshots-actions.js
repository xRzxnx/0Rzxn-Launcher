// Actions de l'onglet Captures : galerie (miniatures servies par shot://), visionneuse, copie, corbeille.
import { api } from './api.js';
import { state, toast, toastError, update } from './state.js';

export function instanceShots(instance) {
  if (!state.screenshots.lists[instance.id]) refreshShots(instance);
  return state.screenshots.lists[instance.id];
}

export async function refreshShots(instance) {
  state.screenshots.lists[instance.id] = { ...(state.screenshots.lists[instance.id] ?? {}), loading: true };
  try {
    const items = await api.screenshots(instance.id);
    update((s) => { s.screenshots.lists[instance.id] = { items, loading: false }; });
  } catch (error) {
    update((s) => { s.screenshots.lists[instance.id] = { items: [], loading: false, error: error.message }; });
  }
}

/** Adresse de l'image ; la date évite de garder en cache une capture remplacée. */
export const shotUrl = (instanceId, shot, kind = 'thumb') =>
  `shot://${kind}/${encodeURIComponent(instanceId)}/${encodeURIComponent(shot.file)}?v=${Math.round(shot.takenAt)}`;

export function openViewer(instance, shot) {
  update((s) => { s.modal = { type: 'screenshot', instanceId: instance.id, file: shot.file }; });
}

/** Capture précédente (-1) ou suivante (+1) dans la visionneuse. */
export function stepViewer(delta) {
  const modal = state.modal;
  if (modal?.type !== 'screenshot') return;
  const items = state.screenshots.lists[modal.instanceId]?.items ?? [];
  const index = items.findIndex((s) => s.file === modal.file);
  const next = items[index + delta];
  if (next) update(() => { modal.file = next.file; });
}

export function viewerKeys(event) {
  if (state.modal?.type !== 'screenshot') return;
  if (event.key === 'ArrowLeft') stepViewer(-1);
  if (event.key === 'ArrowRight') stepViewer(1);
}

export async function copyShot(instanceId, shot) {
  try {
    await api.copyScreenshot(instanceId, shot.file);
    toast({ kind: 'success', title: 'Image copiée dans le presse-papiers', timeout: 3000 });
  } catch (error) {
    toastError('Copie impossible', error);
  }
}

export function openShot(instanceId, shot) {
  api.openScreenshot(instanceId, shot.file).catch((error) => toastError("Impossible d'ouvrir l'image", error));
}

export function showShot(instanceId, shot) {
  api.showScreenshot(instanceId, shot.file).catch((error) => toastError("Impossible d'ouvrir le dossier", error));
}

export async function deleteShot(instance, shot) {
  const items = state.screenshots.lists[instance.id]?.items ?? [];
  const index = items.findIndex((s) => s.file === shot.file);
  try {
    await api.deleteScreenshot(instance.id, shot.file);
    // La visionneuse passe à la capture suivante (ou se ferme s'il n'y en a plus).
    update((s) => {
      const list = s.screenshots.lists[instance.id];
      if (list) list.items = items.filter((i) => i.file !== shot.file);
      if (s.modal?.type === 'screenshot') {
        const next = list?.items[Math.min(index, (list?.items.length ?? 1) - 1)];
        if (next) s.modal.file = next.file;
        else s.modal = null;
      }
    });
    toast({ kind: 'success', title: 'Capture supprimée', text: 'Elle est dans la corbeille de Windows.', timeout: 4000 });
  } catch (error) {
    toastError('Suppression impossible', error);
  }
}

export function openShotsFolder(instance) {
  api.openScreenshotsFolder(instance.id).catch((error) => toastError("Impossible d'ouvrir le dossier", error));
}
