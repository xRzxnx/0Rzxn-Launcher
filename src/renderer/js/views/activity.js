// Page Activité : tâches en cours (barre, fichiers, octets, vitesse, temps restant), en attente (ordre de passage)
// et historique (terminé, échec avec son message, annulé). Écran Preact (ui.js) : la progression ne redessine que les barres.
import { t } from '../i18n.js';
import { h, icon } from '../ui.js';
import { cancelTask, clearTaskHistory, loadTaskHistory, setActivity } from '../activity-actions.js';
import { formatWhen, historyDetail, progressFacts, taskFamily, taskName, taskPercent, taskWhere } from '../task-labels.js';
import { state } from '../state.js';

const FAMILY_ICONS = { pack: 'mods', save: 'archive', play: 'play' };
const STATES = {
  done: { cls: 'ok', icon: 'check', get label() { return t('activity.termine'); } },
  failed: { cls: 'ko', icon: 'alert', get label() { return t('activity.echec'); } },
  cancelled: { cls: 'no', icon: 'close', get label() { return t('activity.annule'); } },
};

/** Pourquoi une tâche attend : une autre tâche de la même instance, ou la limite de deux à la fois. */
function waitReason(task, running) {
  const same = running.find((other) => other.instanceId && other.instanceId === task.instanceId);
  if (same) return t('activity.attend_meme_instance', { task: taskName(same, state.instances) });
  if (task.instanceId && state.run?.instanceId === task.instanceId) return t('activity.attend_la_fin_de_la_partie');
  return t('activity.attend_une_place');
}

function runningCard(task) {
  const family = taskFamily(task.kind);
  const name = taskName(task, state.instances);
  const percent = taskPercent(task);
  const facts = progressFacts(task);
  return h(
    'div',
    { key: task.id, class: 'activity-task' },
    h('span', { class: `activity-task__icon activity-task__icon--${family}` }, icon(FAMILY_ICONS[family], 20)),
    h('span', { class: 'activity-task__name' }, h('span', null, name), h('small', null, taskWhere(task, state.instances))),
    h(
      'span',
      { class: 'activity-task__actions' },
      task.cancellable
        ? h('button', { class: 'btn btn--sm btn--ghost-danger', onClick: () => cancelTask(task.id) }, t('common.annuler'))
        : h('span', { class: 'activity-task__note' }, t('activity.ne_peut_pas_etre_annulee')),
    ),
    h(
      'span',
      { class: 'activity-task__facts' },
      h('b', null, percent == null ? t('activity.preparation') : t('activity.pourcent', { value: percent })),
      facts.map((fact) => h('span', null, fact)),
    ),
    h(
      'span',
      { class: `activity-task__bar activity-task__bar--${family}`, role: 'progressbar', 'aria-valuenow': percent ?? 0, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': name },
      h('span', { style: `width:${percent ?? 4}%` }),
    ),
  );
}

function queuedRow(task, rank, running) {
  return h(
    'div',
    { key: task.id, class: 'activity-wait' },
    h('span', { class: 'activity-wait__rank' }, rank),
    h('span', { class: 'activity-wait__body' }, h('b', null, taskName(task, state.instances)), h('small', null, waitReason(task, running))),
    h('button', { class: 'btn btn--sm btn--ghost', onClick: () => cancelTask(task.id) }, t('activity.retirer')),
  );
}

function historyRow(task) {
  const look = STATES[task.state] ?? STATES.failed;
  const failed = task.state === 'failed';
  const open = failed && state.activity.open === task.id;
  // Seule une ligne en échec se déplie (son message d'erreur) : c'est alors un bouton.
  return h(
    failed ? 'button' : 'div',
    {
      key: task.id,
      class: `activity-row${failed ? ' activity-row--failed' : ''}`,
      'aria-expanded': failed ? (open ? 'true' : 'false') : null,
      onClick: failed ? () => setActivity({ open: open ? null : task.id }) : null,
    },
    h('span', { class: `activity-row__state activity-row__state--${look.cls}`, 'aria-hidden': 'true' }, icon(look.icon, 15)),
    h('span', { class: 'activity-row__body' }, h('b', null, taskName(task, state.instances)), h('small', null, historyDetail(task, state.instances))),
    h('span', { class: 'activity-row__when' }, look.label),
    h('span', { class: 'activity-row__when' }, task.endedAt ? formatWhen(task.endedAt) : ''),
    open && h('span', { class: 'activity-row__error' }, task.error || t('activity.sans_message')),
  );
}

function historySection() {
  const history = state.activity.history;
  if (history === null) {
    loadTaskHistory();
    return h('p', { class: 'activity__note' }, t('common.chargement'));
  }
  const filter = state.activity.filter;
  const shown = history.filter((task) => filter === 'all' || task.state === 'failed');
  const pick = (id, label) =>
    h('button', { type: 'button', 'aria-pressed': filter === id ? 'true' : 'false', onClick: () => setActivity({ filter: id }) }, label);
  return [
    h(
      'div',
      { key: 'head', class: 'activity__history-head' },
      h('h2', { class: 'activity__heading' }, t('activity.historique')),
      h('span', { class: 'page__spacer' }),
      h('div', { class: 'segmented activity__filter', role: 'group', 'aria-label': t('activity.filtrer_historique') }, pick('all', t('activity.tout')), pick('failed', t('activity.echecs'))),
      h('button', { class: 'btn btn--sm btn--ghost', disabled: history.length === 0, onClick: clearTaskHistory }, t('activity.effacer_historique')),
    ),
    h(
      'div',
      { key: 'list', class: 'activity__history' },
      shown.map(historyRow),
      shown.length === 0 && h('p', { class: 'activity__note' }, filter === 'failed' && history.length ? t('activity.aucun_echec') : t('activity.aucune_tache_terminee')),
    ),
  ];
}

export function renderActivity() {
  const visible = state.tasks.filter((task) => !task.hidden);
  const running = visible.filter((task) => task.state === 'running');
  const queued = visible.filter((task) => task.state === 'queued');
  const nothing = visible.length === 0 && state.activity.history?.length === 0;
  const summary = visible.length
    ? [t('activity.en_cours_count', { count: running.length }), queued.length > 0 && t('activity.en_attente_count', { count: queued.length })].filter(Boolean).join(' · ')
    : t('activity.rien_en_cours');

  return h(
    'div',
    { class: 'page activity' },
    h('div', { class: 'page__head' }, h('div', null, h('h1', { class: 'page__title' }, t('activity.activite')), h('p', { class: 'activity__summary' }, summary))),
    nothing
      ? h(
          'div',
          { class: 'empty activity__empty' },
          icon('activity', 40),
          h('h2', { class: 'empty__title' }, t('activity.rien_en_cours')),
          h('p', { class: 'empty__text' }, t('activity.vide_texte')),
        )
      : h(
          'div',
          { class: 'activity__scroll' },
          running.length > 0 && h('h2', { class: 'activity__heading' }, t('activity.en_cours'), h('span', null, running.length)),
          running.map(runningCard),
          queued.length > 0 && h('h2', { class: 'activity__heading' }, t('activity.en_attente'), h('span', null, t('activity.passeront_dans_cet_ordre'))),
          queued.map((task, i) => queuedRow(task, i + 1, running)),
          historySection(),
        ),
  );
}
