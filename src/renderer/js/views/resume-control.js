// Bouton « Reprendre » de l'accueil : entrer directement dans un monde ou sur un serveur joué récemment.
// Écran Preact (ui.js) ; le menu du clic droit de la barre latérale reste dans resume.js.
import { t } from '../i18n.js';
import { formatLastPlayed } from '../data.js';
import { h, icon } from '../ui.js';
import { activeAccount, state, update } from '../state.js';
import { resume, resumeTargets, watchOutside } from './resume.js';

function targetIcon(target) {
  return h('span', { class: `resume-icon resume-icon--${target.type}`, 'aria-hidden': 'true' }, icon(target.type === 'singleplayer' ? 'worlds' : 'link', 16));
}

/** Bouton partagé « Reprendre <monde> » + flèche des 5 derniers, à côté de Jouer. */
export function resumeControl(instance) {
  const targets = resumeTargets(instance);
  if (!targets.length || !activeAccount() || state.run || !instance.installed) return null;
  const [first] = targets;
  const open = state.resumeMenu === instance.id;
  return h(
    'div',
    { class: 'resume' },
    h(
      'button',
      { class: 'resume__main', onClick: () => resume(instance, first), title: t('resume.entrer_directement', { name: first.name }) },
      targetIcon(first),
      h('span', { class: 'resume__text' }, h('span', { class: 'label' }, t('resume.reprendre')), h('span', { class: 'resume__name' }, first.name)),
    ),
    h(
      'button',
      {
        class: 'resume__more',
        'aria-label': t('resume.derniers_mondes_et_serveurs'),
        'aria-expanded': open ? 'true' : 'false',
        'aria-haspopup': 'menu',
        onClick: () => {
          update((s) => { s.resumeMenu = open ? null : instance.id; });
          if (!open) watchOutside();
        },
      },
      icon('chevron', 16),
    ),
    open &&
      h(
        'div',
        { class: 'resume-menu', role: 'menu', 'aria-label': t('resume.derniers_mondes_et_serveurs') },
        h('div', { class: 'resume-menu__head' }, t('resume.entrer_dans')),
        targets.map((target) =>
          h(
            'button',
            { class: 'resume-menu__item', role: 'menuitem', onClick: () => resume(instance, target) },
            targetIcon(target),
            h(
              'span',
              { class: 'resume-menu__body' },
              h('b', null, target.name),
              h('span', null, [target.type === 'singleplayer' ? t('resume.monde') : t('resume.serveur'), formatLastPlayed(target.at)].filter(Boolean).join(' · ')),
            ),
          ),
        ),
        !instance.quickPlay && h('p', { class: 'resume-menu__foot' }, t('resume.serveurs_seulement')),
      ),
  );
}
