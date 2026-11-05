// Recherche globale (Ctrl+K) : champ, groupes de résultats et pied avec les touches.
import { blockIcon, h, icon } from '../dom.js';
import { closePalette, paletteGroups, paletteKey, setPaletteActive, setPaletteQuery } from '../palette-actions.js';

const kbd = (text) => h('span', { class: 'kbd' }, text);

function row(item, active) {
  const lead =
    item.kind === 'instance'
      ? blockIcon(item.instance.icon, 'palette__block')
      : h('span', { class: 'palette__icon' }, icon(item.kind === 'mod' ? 'mods' : item.icon, 18));
  return h(
    'div',
    {
      class: 'palette__row',
      id: `palette-opt-${item.index}`,
      role: 'option',
      'aria-selected': active ? 'true' : 'false',
      'data-reveal': active && item.reveal ? '' : null,
      onMousedown: (e) => e.preventDefault(), // le champ garde le focus
      onMousemove: () => setPaletteActive(item.index),
      onClick: (e) => item.run(e.shiftKey),
    },
    lead,
    h('span', { class: 'palette__label' }, item.label),
    h('span', { class: 'palette__meta' }, active && item.hint ? `${item.meta.split(' · ').slice(0, 1)[0]} · ${item.hint}` : item.meta),
  );
}

export function paletteDialog(modal) {
  const groups = paletteGroups(modal.query);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const active = Math.min(modal.active, Math.max(0, total - 1));
  const activeId = total ? `palette-opt-${active}` : null;

  const list = h('div', { class: 'palette__list', id: 'palette-list', role: 'listbox', 'aria-label': 'Résultats', 'data-scroll-key': 'palette' });
  for (const group of groups) {
    const titleId = `palette-group-${group.id}`;
    list.append(
      h(
        'div',
        { class: 'palette__group', role: 'group', 'aria-labelledby': titleId },
        h('div', { class: 'palette__title', id: titleId }, group.title),
        group.items.map((item) => {
          const on = item.index === active;
          if (on && modal.reveal) item.reveal = true;
          return row(item, on);
        }),
      ),
    );
  }

  return h(
    'div',
    { class: 'overlay overlay--palette', onClick: (e) => e.target === e.currentTarget && closePalette() },
    h(
      'section',
      { class: 'palette', 'aria-label': 'Recherche globale' },
      h(
        'div',
        { class: 'palette__field' },
        icon('search', 19),
        h('input', {
          id: 'palette-input',
          class: 'palette__input',
          type: 'text',
          role: 'combobox',
          'aria-label': 'Rechercher une instance, un mod ou une action',
          'aria-expanded': 'true',
          'aria-controls': 'palette-list',
          'aria-autocomplete': 'list',
          'aria-activedescendant': activeId,
          autocomplete: 'off',
          spellcheck: 'false',
          placeholder: 'Rechercher une instance, un mod, une action…',
          value: modal.query,
          onInput: (e) => setPaletteQuery(e.target.value),
          onKeydown: paletteKey,
        }),
        kbd('Ctrl K'),
      ),
      total > 0 ? list : h('p', { class: 'palette__empty', role: 'status' }, `Aucun résultat pour « ${modal.query.trim()} »`),
      h(
        'div',
        { class: 'palette__foot' },
        h('span', null, kbd('↑'), kbd('↓'), ' naviguer'),
        h('span', null, kbd('Entrée'), ' ouvrir ou jouer'),
        h('span', null, kbd('Maj'), kbd('Entrée'), ' sélectionner'),
        h('span', null, kbd('Échap'), ' fermer'),
      ),
    ),
  );
}
