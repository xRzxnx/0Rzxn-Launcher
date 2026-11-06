// Paramètres de l'instance : menu Cristal, l'écran titre du jeu aux couleurs du launcher.
import { t } from '../i18n.js';
import { h } from '../dom.js';
import { state } from '../state.js';
import { disableTitleMenu, enableTitleMenu, loadTitleMenu, setTitleMenuCard, setTitleMenuStyle } from '../title-menu-actions.js';

const STYLES = [
  { id: 'colonne', get label() { return t('titlemenu.colonne'); }, get detail() { return t('titlemenu.colonne_detail'); } },
  { id: 'centre', get label() { return t('titlemenu.centre'); }, get detail() { return t('titlemenu.centre_detail'); } },
  { id: 'minimal', get label() { return t('titlemenu.minimal'); }, get detail() { return t('titlemenu.minimal_detail'); } },
];

function styleChoice(instance, menu) {
  return h(
    'div',
    { role: 'radiogroup', 'aria-labelledby': 'title-menu-title', style: 'display:flex;flex-direction:column;gap:6px' },
    STYLES.map((style) =>
      h(
        'button',
        {
          class: 'option',
          role: 'radio',
          'aria-checked': menu.style === style.id ? 'true' : 'false',
          disabled: menu.busy,
          onClick: () => setTitleMenuStyle(instance.id, style.id),
        },
        h('span', { class: 'option__dot', 'aria-hidden': 'true' }),
        h('span', { class: 'option__body' }, h('span', { class: 'option__title' }, style.label), h('span', { class: 'option__detail' }, style.detail)),
      ),
    ),
  );
}

function body(instance, menu) {
  if (!menu.modded) return h('p', { class: 'hint' }, t('titlemenu.vanilla'));
  if (menu.available === false) return h('p', { class: 'hint' }, t('titlemenu.indisponible', { version: instance.version }));
  return [
    h('p', { class: 'hint', style: 'margin:0' }, t('titlemenu.description')),
    styleChoice(instance, menu),
    h(
      'div',
      { class: 'toggle-row' },
      h('span', { id: 'title-card-label' }, t('titlemenu.carte')),
      h('button', {
        class: 'toggle',
        'aria-labelledby': 'title-card-label',
        'aria-pressed': menu.card ? 'true' : 'false',
        disabled: menu.busy,
        onClick: () => setTitleMenuCard(instance.id, !menu.card),
      }),
    ),
    instance.background?.kind === 'image' && h('p', { class: 'hint' }, t('titlemenu.image_perso')),
    menu.conflicts.length > 0 && h('p', { class: 'hint hint--warn' }, t('titlemenu.conflits', { mods: menu.conflicts.join(', ') })),
    menu.active
      ? [
          h('p', { class: 'hint' }, t('titlemenu.editeur')),
          h('div', null, h('button', { class: 'btn', disabled: menu.busy, onClick: () => disableTitleMenu(instance.id) }, t('titlemenu.retirer'))),
        ]
      : [
          h('p', { class: 'hint' }, t(menu.installed ? 'titlemenu.mod_present' : 'titlemenu.mods_ajoutes')),
          h(
            'div',
            null,
            h('button', { class: 'btn btn--primary', disabled: menu.busy, onClick: () => enableTitleMenu(instance.id) }, t(menu.busy ? 'titlemenu.installation' : 'titlemenu.activer')),
          ),
        ],
  ];
}

export function titleMenuSection(instance) {
  const menu = state.titleMenu?.[instance.id];
  if (!menu) loadTitleMenu(instance.id);
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'title-menu-title' },
    h('h2', { class: 'settings__title', id: 'title-menu-title' }, t('titlemenu.titre')),
    menu ? body(instance, menu) : h('p', { class: 'hint' }, t('common.chargement')),
  );
}
