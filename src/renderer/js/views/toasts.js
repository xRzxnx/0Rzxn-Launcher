// Notifications en bas à droite (la progression des tâches longues est dans la page Activité).
// Écran Preact (ui.js) : une notification qui arrive ou disparaît ne redessine pas les autres.
import { t } from '../i18n.js';
import { h, icon } from '../ui.js';
import { dismissToast, state } from '../state.js';

export function renderToasts() {
  return state.toasts.map((item) =>
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
}
