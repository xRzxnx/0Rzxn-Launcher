// Réglages du launcher (thème, Discord, zone de notification) et onglet Java et stockage.
import { api } from './api.js';
import { formatSize } from './dom.js';
import { applyAccent } from './theme.js';
import { state, toast, toastError, update } from './state.js';

export async function loadLauncherPrefs() {
  const prefs = await api.launcherPrefs();
  applyAccent(prefs.accent);
  update((s) => { s.launcherPrefs = prefs; });
}

let saveTimer = null;

/** Change un réglage tout de suite à l'écran, puis l'enregistre (une fois la couleur choisie). */
export function setLauncherPref(patch) {
  if (!state.launcherPrefs) return;
  update((s) => { Object.assign(s.launcherPrefs, patch); });
  if ('accent' in patch) applyAccent(patch.accent);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api.saveLauncherPrefs(state.launcherPrefs);
      if ('discord' in patch || 'discordShowName' in patch) setTimeout(refreshDiscord, 800);
    } catch (error) {
      toastError('Réglages non enregistrés', error);
    }
  }, 250);
}

export async function refreshDiscord() {
  try {
    const status = await api.discordStatus();
    update((s) => { s.discord = status; });
  } catch {
    // statut indisponible : la section reste neutre
  }
}

/** Espace disque, nettoyage possible, Java du launcher et du PC. */
export async function loadStorage({ rescanJavas = false } = {}) {
  if (state.storage.loading) return;
  update((s) => {
    s.storage.loading = true;
    s.storage.error = null;
  });
  try {
    const [usage, plan, runtimes, system] = await Promise.all([api.storageUsage(), api.cleanupPlan(), api.runtimes(), api.systemJavas(rescanJavas)]);
    update((s) => Object.assign(s.storage, { usage, plan, runtimes, system, loading: false }));
  } catch (error) {
    update((s) => Object.assign(s.storage, { loading: false, error: error.message }));
  }
}

/** Java du PC pour « Java › Personnalisé » des paramètres d'une instance. */
export async function loadSystemJavas() {
  if (state.storage.system || state.storage.loadingSystem) return;
  state.storage.loadingSystem = true;
  try {
    const system = await api.systemJavas(false);
    update((s) => { s.storage.system = system; });
  } catch {
    update((s) => { s.storage.system = []; });
  }
}

export function toggleCleanup(id) {
  update((s) => {
    const off = new Set(s.storage.unchecked);
    if (off.has(id)) off.delete(id);
    else off.add(id);
    s.storage.unchecked = [...off];
  });
}

export function selectedCleanup() {
  return (state.storage.plan ?? []).filter((item) => item.count > 0 && !state.storage.unchecked.includes(item.id));
}

export async function removeRuntime(runtime) {
  update((s) => { s.storage.busy = true; });
  try {
    const freed = await api.removeRuntime(runtime.component);
    toast({ kind: 'success', title: `Java ${runtime.major ?? runtime.component} supprimé`, text: `${formatSize(freed)} libérés. Il sera retéléchargé si une instance en a besoin.` });
    update((s) => { s.modal = null; });
  } catch (error) {
    toastError('Suppression impossible', error);
  } finally {
    update((s) => { s.storage.busy = false; });
    loadStorage();
  }
}

export async function cleanStorage(ids) {
  update((s) => { s.storage.busy = true; });
  try {
    const result = await api.cleanStorage(ids);
    update((s) => { s.modal = null; });
    toast({
      kind: result.failed ? 'error' : 'success',
      title: `${formatSize(result.freed)} libérés`,
      text: result.failed ? `${result.failed} fichier${result.failed > 1 ? 's' : ''} n'ont pas pu être supprimés (utilisés par un autre programme ?).` : 'Tout se retéléchargera si une instance en a besoin.',
    });
  } catch (error) {
    toastError('Nettoyage impossible', error);
  } finally {
    update((s) => { s.storage.busy = false; });
    loadStorage();
  }
}
