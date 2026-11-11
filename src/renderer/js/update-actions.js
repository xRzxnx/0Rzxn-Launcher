// Mises à jour du launcher : l'interface suit l'état tenu par le processus principal.
import { api } from './api.js';
import { t } from './i18n.js';
import { state, tasksBusy, toastError, update } from './state.js';

export async function loadUpdate() {
  const status = await api.updateState();
  update((s) => { s.launcherUpdate = status; });
  api.on.updateStatus((next) => update((s) => { s.launcherUpdate = next; }));
}

export async function checkUpdate() {
  try {
    await api.checkUpdate();
  } catch (error) {
    toastError(t('update.check_failed'), error);
  }
}

export async function installUpdate() {
  try {
    await api.installUpdate();
  } catch (error) {
    toastError(t('update.restart_failed'), error);
  }
}

/** Ce qui empêche de redémarrer le launcher : 'game', 'install', sinon une chaîne vide. */
export function updateBlocker() {
  if (state.run) return 'game';
  return tasksBusy() ? 'install' : '';
}

/** Phrase affichée pendant que la nouvelle version attend. */
export const updateWaitText = (version, blocker) => t(blocker === 'install' ? 'update.wait_install' : 'update.wait_game', { version });
