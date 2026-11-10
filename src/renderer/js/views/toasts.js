// Notifications en bas à droite et carte de progression de la tâche longue.
// Écran Preact (ui.js) : une notification qui arrive ou disparaît ne redessine pas les autres.
import { t } from '../i18n.js';
import { h, icon } from '../ui.js';
import { dismissToast, state } from '../state.js';

/** Carte de progression d'une tâche longue (installation ou mise à jour d'un modpack). */
function taskCard(task) {
  const percent = task.total ? Math.round((task.done / task.total) * 100) : null;
  return h(
    'div',
    { key: 'task', class: 'toast toast--info', role: 'status' },
    h('span', { class: 'toast__icon' }, icon('download')),
    h(
      'span',
      { class: 'toast__body' },
      h('span', { class: 'toast__title' }, task.label),
      h('span', { class: 'toast__text' }, task.total ? t('modals.task_files', { done: task.done, total: task.total }) : t('modals.preparation')),
      h('span', { class: 'progress', style: 'margin-top:6px;height:10px' }, h('span', { class: 'progress__fill', style: `display:block;width:${percent ?? 5}%` })),
    ),
  );
}

export function renderToasts() {
  const toasts = state.toasts.map((item) =>
    h(
      'div',
      { key: item.id, class: `toast toast--${item.kind}`, role: item.kind === 'error' ? 'alert' : 'status' },
      h('span', { class: 'toast__icon' }, icon(item.kind === 'success' ? 'check' : item.kind === 'error' ? 'alert' : 'info')),
      h(
        'span',
        { class: 'toast__body' },
        h('span', { class: 'toast__title' }, item.title),
        item.text && h('span', { class: 'toast__text' }, item.text),
        item.actions.length > 0 &&
          h(
            'span',
            { class: 'toast__actions' },
            item.actions.map((a) => h('button', { class: 'btn', onClick: () => { dismissToast(item.id); a.run(); } }, a.label)),
          ),
      ),
      h('button', { class: 'dialog__close', style: 'width:28px;height:28px', 'aria-label': t('modals.fermer_la_notification'), onClick: () => dismissToast(item.id) }, icon('close')),
    ),
  );
  return state.task ? [taskCard(state.task), ...toasts] : toasts;
}
