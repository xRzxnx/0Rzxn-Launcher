// Mises à jour du launcher : l'interface suit l'état tenu par le processus principal.
import { api } from './api.js';
import { state, toastError, update } from './state.js';

export async function loadUpdate() {
  const status = await api.updateState();
  update((s) => { s.launcherUpdate = status; });
  api.on.updateStatus((next) => update((s) => { s.launcherUpdate = next; }));
}

export async function checkUpdate() {
  try {
    await api.checkUpdate();
  } catch (error) {
    toastError('Recherche impossible', error);
  }
}

export async function installUpdate() {
  try {
    await api.installUpdate();
  } catch (error) {
    toastError('Redémarrage impossible', error);
  }
}

/** Ce qui empêche de redémarrer le launcher, sinon une chaîne vide. */
export function updateBlocker() {
  if (state.run) return 'ta partie';
  return state.task ? "l'installation" : '';
}
