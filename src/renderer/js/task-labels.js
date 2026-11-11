// Libellés de la page Activité : refaits à chaque affichage depuis `kind` + `params` (la langue a pu changer
// depuis que la tâche a été créée ; le libellé enregistré par le processus principal ne sert qu'en dernier recours).
// Aucun accès au DOM ici : testé sous node dans les trois langues (test/task-labels.test.js).
import { formatDateTime, num, t } from './i18n.js';
import { formatSize } from './dom.js';
import { LAUNCH_STEPS } from './data.js';

const STEP_COUNT = LAUNCH_STEPS.length;

/** Profils de l'assistant (titres traduits dans l'interface). */
const PROFILE_TITLES = {
  get survival() { return t('wizard.survie_optimisee'); },
  pvp: 'PvP',
  shaders: 'Shaders',
  get creative() { return t('wizard.creatif'); },
};

const NAMES = {
  'modpack-install': (p) => t('activity.installation_de', { name: p.title || 'modpack' }),
  'modpack-import': (p) => (p.file ? t('activity.import_de', { name: p.file }) : null),
  'modpack-update': (p, instance) => t('activity.mise_a_jour_de', { name: instance ?? p.name ?? 'modpack' }),
  'instance-import': (p) => (p.source ? t('activity.import_de', { name: p.source }) : null),
  'world-backup': (p) => (p.folder ? t('activity.sauvegarde_de', { name: p.folder }) : null),
  'world-restore': (p) => (p.file ? t('activity.restauration_de', { name: p.file }) : null),
  'worlds-auto-backup': () => t('activity.sauvegarde_des_mondes'),
  'perf-pack': () => t('activity.pack_performances'),
  'profile-mods': (p) => (PROFILE_TITLES[p.profileId] ? t('activity.mods_du_profil', { title: PROFILE_TITLES[p.profileId] }) : null),
  'launch-prepare': (p) => (p.prepareOnly ? t('activity.verification_des_fichiers') : t('activity.preparation_de_la_partie')),
  'temp-cleanup': () => t('activity.nettoyage'),
};

/** Nom de l'instance d'une tâche : celui d'aujourd'hui s'il existe encore, sinon celui noté avec la tâche. */
export function instanceName(task, instances = []) {
  return instances.find((i) => i.id === task.instanceId)?.name ?? task.params?.name ?? null;
}

/** Nom de la tâche dans la langue du moment. */
export function taskName(task, instances = []) {
  const make = NAMES[task.kind];
  return (make && make(task.params ?? {}, instances.find((i) => i.id === task.instanceId)?.name ?? null)) || task.label || t('activity.tache');
}

/** Famille d'icône et de couleur : contenu (pack), sauvegarde (save) ou partie (play). */
export function taskFamily(kind) {
  if (kind === 'launch-prepare') return 'play';
  if (kind === 'world-backup' || kind === 'world-restore' || kind === 'worlds-auto-backup') return 'save';
  return 'pack';
}

/** Progression de 0 à 100, ou null tant qu'elle n'est pas connue. La préparation d'une partie compte ses 9 étapes. */
export function taskPercent(task) {
  const p = task.progress ?? {};
  if (task.kind === 'launch-prepare') {
    const inStep = p.total ? p.done / p.total : 0;
    return Math.min(100, Math.round((((p.step ?? 0) + inStep) / STEP_COUNT) * 100));
  }
  if (p.totalBytes) return Math.min(100, Math.round(((p.doneBytes ?? 0) / p.totalBytes) * 100));
  return p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : null;
}

/** Ligne sous le nom : instance, ou provenance ; étape en cours pour une partie. */
export function taskWhere(task, instances = []) {
  const name = instanceName(task, instances);
  if (task.kind === 'launch-prepare' && task.state === 'running' && task.progress?.step != null) {
    const step = Math.min(task.progress.step, STEP_COUNT - 1);
    const detail = t('activity.etape', { step: step + 1, count: STEP_COUNT, name: LAUNCH_STEPS[step].name });
    return name ? `${name} · ${detail}` : detail;
  }
  if (task.kind === 'instance-import') return t('activity.depuis_un_autre_launcher');
  if (task.kind === 'modpack-install' || task.kind === 'modpack-import') return name ?? t('activity.nouvelle_instance');
  return name ?? '';
}

/** « 4 s », « 1 min 12 s », « 1 h 05 ». */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return t('activity.secondes', { s: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('activity.minutes', { m: minutes, s: seconds % 60 });
  return t('activity.heures', { h: Math.floor(minutes / 60), m: String(minutes % 60).padStart(2, '0') });
}

/** Faits de la tâche en cours : fichiers, octets, vitesse, temps restant (seulement ce qui est connu). */
export function progressFacts(task) {
  const p = task.progress ?? {};
  const facts = [];
  if (p.total) facts.push(t('activity.fichiers_sur', { done: num(p.done), count: p.total }));
  if (p.totalBytes) facts.push(`${formatSize(p.doneBytes ?? 0)} / ${formatSize(p.totalBytes)}`);
  if (p.speed) facts.push(t('activity.par_seconde', { size: formatSize(p.speed) }));
  if (p.eta != null && p.speed) facts.push(t('activity.reste', { time: formatDuration(p.eta * 1000) }));
  return facts;
}

/** Détail d'une tâche finie : instance, fichiers, taille, durée (ou « Annulée après… », « 3 fichiers sur 7 »). */
export function historyDetail(task, instances = []) {
  const p = task.progress ?? {};
  const duration = task.startedAt && task.endedAt ? task.endedAt - task.startedAt : null;
  const parts = [taskWhere({ ...task, state: task.state }, instances)];
  if (task.state === 'done') {
    if (p.total) parts.push(t('activity.fichiers', { count: p.total }));
    if (p.totalBytes) parts.push(formatSize(p.totalBytes));
    if (duration != null) parts.push(formatDuration(duration));
  } else if (task.state === 'cancelled') {
    parts.push(duration != null ? t('activity.annulee_apres', { time: formatDuration(duration) }) : t('activity.annulee_avant_de_commencer'));
  } else if (p.total) {
    parts.push(t('activity.fichiers_sur', { done: num(p.done ?? 0), count: p.total }));
  }
  return parts.filter(Boolean).join(' · ');
}

const DAY = 24 * 3600 * 1000;
const startOfDay = (time) => {
  const d = new Date(time);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** « Aujourd'hui, 21:13 », « Hier, 22:05 », sinon « 8 nov., 21:13 ». */
export function formatWhen(time, now = Date.now()) {
  const clock = formatDateTime(new Date(time), { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((startOfDay(now) - startOfDay(time)) / DAY);
  if (days === 0) return t('activity.aujourd_hui', { time: clock });
  if (days === 1) return t('activity.hier', { time: clock });
  return t('activity.le', { date: formatDateTime(new Date(time), { day: 'numeric', month: 'short' }), time: clock });
}

/** Résumé de la barre latérale : tâches visibles en cours ou en attente, progression moyenne des tâches en cours. */
export function activitySummary(tasks = []) {
  const visible = tasks.filter((task) => !task.hidden);
  const running = visible.filter((task) => task.state === 'running');
  const percents = running.map(taskPercent).map((p) => p ?? 0);
  const percent = percents.length ? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length) : 0;
  return { count: visible.length, running: running.length, queued: visible.length - running.length, percent };
}
