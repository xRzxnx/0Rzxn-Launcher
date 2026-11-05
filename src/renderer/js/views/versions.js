// Onglet Versions : liste officielle Mojang, filtrable, avec panneau de détail.
import { versionDetails } from '../actions.js';
import { VERSION_TYPES, formatDate } from '../data.js';
import { h, icon } from '../dom.js';
import { state, update } from '../state.js';
import { openNewInstance } from './chrome.js';

const FILTERS = ['release', 'snapshot', 'beta', 'alpha'];
const FILTER_LABELS = { release: 'Releases', snapshot: 'Snapshots', beta: 'Bêta', alpha: 'Alpha' };

function visibleVersions() {
  const { list, filters, query } = state.versions;
  const anyType = FILTERS.some((f) => filters[f]);
  const q = query.trim().toLowerCase();
  return list.filter((v) => (!anyType || filters[v.type] || !FILTERS.includes(v.type)) && (!q || v.id.toLowerCase().includes(q)));
}

function usedBy(versionId) {
  return state.instances.filter((i) => i.version === versionId).map((i) => i.name);
}

function table() {
  const rows = visibleVersions();
  let message = null;
  if (state.versions.loading) message = 'Chargement de la liste Mojang…';
  else if (state.versions.error) message = state.versions.error;
  else if (rows.length === 0) message = 'Aucune version ne correspond.';

  return h(
    'div',
    { class: 'vtable', role: 'grid', 'aria-label': 'Versions de Minecraft' },
    h(
      'div',
      { class: 'vtable__row vtable__head', role: 'row' },
      ['Version', 'Type', 'Sortie', 'Installée', 'Instance'].map((label) => h('span', { role: 'columnheader' }, label)),
    ),
    h(
      'div',
      { class: 'vtable__rows', 'data-scroll-key': 'versions-rows' },
      message && h('p', { class: 'vtable__empty' }, message),
      rows.map((v) =>
        h(
          'button',
          {
            class: 'vtable__row',
            role: 'row',
            'aria-selected': v.id === state.versions.selected ? 'true' : 'false',
            onClick: () => update((s) => { s.versions.selected = v.id; }),
            onDblclick: () => openNewInstance(v.id),
          },
          h('span', { class: 'vtable__id', role: 'gridcell' }, v.id),
          h('span', { role: 'gridcell' }, h('span', { class: `tag tag--${FILTERS.includes(v.type) ? v.type : 'release'}` }, VERSION_TYPES[v.type] ?? v.type)),
          h('span', { class: 'vtable__cell', role: 'gridcell' }, formatDate(v.releaseTime)),
          h('span', { class: 'vtable__cell vtable__cell--mono', role: 'gridcell' }, v.installed ? 'Oui' : '—'),
          h('span', { class: 'vtable__cell vtable__cell--strong', role: 'gridcell' }, usedBy(v.id).join(', ') || '—'),
        ),
      ),
    ),
  );
}

function detail() {
  const v = state.versions.list.find((x) => x.id === state.versions.selected);
  if (!v) return h('aside', { class: 'detail', 'aria-label': 'Détails de la version' }, h('span', { class: 'label' }, 'Aucune version sélectionnée'));
  const details = versionDetails(v.id);
  const errored = state.versionDetails[v.id]?.error;
  const instances = usedBy(v.id);
  return h(
    'aside',
    { class: 'detail', 'aria-label': 'Détails de la version' },
    h('span', { class: 'label' }, 'Version sélectionnée'),
    h(
      'div',
      { style: 'display:flex;flex-direction:column;gap:10px;align-items:flex-start' },
      h('span', { class: 'detail__id' }, v.id),
      h('span', { class: `tag tag--${FILTERS.includes(v.type) ? v.type : 'release'}` }, VERSION_TYPES[v.type] ?? v.type),
    ),
    h(
      'dl',
      { class: 'detail__list' },
      h('dt', null, 'Sortie'),
      h('dd', null, formatDate(v.releaseTime)),
      h('dt', null, 'Java requis'),
      h('dd', null, details ? `Java ${details.java} (auto)` : errored ? 'inconnu' : '…'),
      h('dt', null, 'Installée'),
      h('dd', null, v.installed ? 'Oui' : 'Non'),
      h('dt', null, 'Instance'),
      h('dd', null, instances.join(', ') || "Aucune pour l'instant"),
    ),
    h('div', { class: 'detail__spacer' }),
    h('button', { class: 'btn btn--primary btn--lg', onClick: () => openNewInstance(v.id) }, icon('plus'), 'Créer une instance'),
  );
}

export function renderVersions() {
  const { filters, query, list, offline } = state.versions;
  const counts = Object.fromEntries(FILTERS.map((f) => [f, list.filter((v) => v.type === f).length]));
  return h(
    'div',
    { style: 'display:flex;height:100%' },
    h(
      'div',
      { class: 'versions' },
      h(
        'div',
        { class: 'page__head' },
        h('h1', { class: 'page__title' }, 'Versions'),
        h('span', { class: 'page__meta' }, `${list.length} versions · liste officielle Mojang${offline ? ' · hors connexion (cache)' : ''}`),
      ),
      h(
        'div',
        { class: 'toolbar' },
        h(
          'label',
          { class: 'search' },
          icon('search'),
          h('span', { class: 'visually-hidden' }, 'Rechercher une version'),
          h('input', {
            id: 'versions-search',
            type: 'search',
            placeholder: 'Rechercher : 26.3, 1.21, snapshot…',
            value: query,
            onInput: (e) => update((s) => { s.versions.query = e.target.value; }),
          }),
        ),
        h(
          'div',
          { role: 'group', 'aria-label': 'Filtres', style: 'display:flex;gap:6px' },
          FILTERS.map((f) =>
            h(
              'button',
              { class: 'chip', 'aria-pressed': filters[f] ? 'true' : 'false', onClick: () => update((s) => { s.versions.filters[f] = !s.versions.filters[f]; }) },
              FILTER_LABELS[f],
              h('span', { class: 'chip__count' }, counts[f]),
            ),
          ),
        ),
      ),
      table(),
    ),
    detail(),
  );
}
