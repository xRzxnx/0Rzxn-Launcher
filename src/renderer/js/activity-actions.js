// Page Activité : file des tâches longues (tasks:changed), historique (launcher.db), annulation.
import { api } from './api.js';
import { t } from './i18n.js';
import { state, toastError, update } from './state.js';

let historyTimer = null;

/** Liste des tâches tenue à jour ; l'historique est relu quand une tâche se termine (s'il a déjà été chargé). */
export function listenToTasks() {
  api.tasks().then((list) => update((s) => { s.tasks = list; }), () => {});
  api.on.tasks((list) => {
    const ended = state.tasks.some((task) => !list.some((other) => other.id === task.id));
    update((s) => { s.tasks = list; });
    if (ended && state.activity.history) {
      clearTimeout(historyTimer);
      historyTimer = setTimeout(loadTaskHistory, 150);
    }
  });
}

let loadingHistory = false;

export async function loadTaskHistory() {
  if (loadingHistory) return;
  loadingHistory = true;
  try {
    const history = await api.taskHistory(50);
    update((s) => { s.activity.history = history; });
  } catch (error) {
    update((s) => { s.activity.history = s.activity.history ?? []; });
    toastError(t('activity.historique_illisible'), error);
  } finally {
    loadingHistory = false;
  }
}

export function openActivity() {
  update((s) => { s.view = 'activity'; });
}

/** Bouton des notifications de fin de tâche. */
export function activityAction() {
  return { label: t('activity.voir_l_activite'), run: openActivity };
}

export async function cancelTask(id) {
  try {
    await api.cancelTask(id);
  } catch (error) {
    toastError(t('activity.annulation_impossible'), error);
  }
}

export async function clearTaskHistory() {
  try {
    await api.clearTaskHistory();
    update((s) => {
      s.activity.history = [];
      s.activity.open = null;
    });
  } catch (error) {
    toastError(t('activity.effacement_impossible'), error);
  }
}

export function setActivity(patch) {
  update((s) => { Object.assign(s.activity, patch); });
}

/** Tâche visible (en cours, sinon en attente) qui touche cette instance, ou null. */
export function instanceTask(instanceId, match = () => true) {
  const mine = state.tasks.filter((task) => !task.hidden && task.instanceId === instanceId && match(task));
  return mine.find((task) => task.state === 'running') ?? mine[0] ?? null;
}
