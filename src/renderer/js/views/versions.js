// Onglet Versions : liste officielle Mojang, filtrable, avec panneau de détail.
import { t } from '../i18n.js';
import { versionDetails } from '../actions.js';
import { VERSION_TYPES, formatDate } from '../data.js';
import { h, icon } from '../dom.js';
import { state, update } from '../state.js';
import { openNewInstance } from './chrome.js';

const FILTERS = ['release', 'snapshot', 'beta', 'alpha'];
const FILTER_LABELS = { get release() { return t('versions.releases'); }, get snapshot() { return t('versions.snapshots'); }, get beta() { return t('common.beta'); }, alpha: 'Alpha' };

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
  if (state.versions.loading) message = t('versions.chargement_de_la_liste_mojang');
  else if (state.versions.error) message = state.versions.error;
  else if (rows.length === 0) message = t('versions.aucune_version_ne_correspond');

  return h(
    'div',
    { class: 'vtable', role: 'grid', 'aria-label': t('versions.versions_de_minecraft') },
    h(
      'div',
      { class: 'vtable__row vtable__head', role: 'row' },
      [t('common.version'), t('versions.type'), t('versions.sortie'), t('versions.installee'), t('common.instance')].map((label) => h('span', { role: 'columnheader' }, label)),
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
          h('span', { class: 'vtable__cell vtable__cell--mono', role: 'gridcell' }, v.installed ? t('versions.oui') : '—'),
          h('span', { class: 'vtable__cell vtable__cell--strong', role: 'gridcell' }, usedBy(v.id).join(', ') || '—'),
        ),
      ),
    ),
  );
}

function detail() {
  const v = state.versions.list.find((x) => x.id === state.versions.selected);
  if (!v) return h('aside', { class: 'detail', 'aria-label': t('versions.details_de_la_version') }, h('span', { class: 'label' }, t('versions.aucune_version_selectionnee')));
  const details = versionDetails(v.id);
  const errored = state.versionDetails[v.id]?.error;
  const instances = usedBy(v.id);
  return h(
    'aside',
    { class: 'detail', 'aria-label': t('versions.details_de_la_version') },
    h('span', { class: 'label' }, t('versions.version_selectionnee')),
    h(
      'div',
      { style: 'display:flex;flex-direction:column;gap:10px;align-items:flex-start' },
      h('span', { class: 'detail__id' }, v.id),
      h('span', { class: `tag tag--${FILTERS.includes(v.type) ? v.type : 'release'}` }, VERSION_TYPES[v.type] ?? v.type),
    ),
    h(
      'dl',
      { class: 'detail__list' },
      h('dt', null, t('versions.sortie')),
      h('dd', null, formatDate(v.releaseTime)),
      h('dt', null, t('versions.java_requis')),
      h('dd', null, details ? t('versions.java_auto', { java: details.java }) : errored ? t('versions.unknown') : '…'),
      h('dt', null, t('versions.installee')),
      h('dd', null, v.installed ? t('versions.oui') : t('versions.non')),
      h('dt', null, t('common.instance')),
      h('dd', null, instances.join(', ') || t('versions.aucune_pour_instant')),
    ),
    h('div', { class: 'detail__spacer' }),
    h('button', { class: 'btn btn--primary btn--lg', onClick: () => openNewInstance(v.id) }, icon('plus'), t('common.creer_une_instance')),
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
        h('h1', { class: 'page__title' }, t('common.versions')),
        h('span', { class: 'page__meta' }, t('versions.versions_liste_officielle_mojang', { list: list.length, value: offline ? t('versions.hors_connexion_cache') : '' })),
      ),
      h(
        'div',
        { class: 'toolbar' },
        h(
          'label',
          { class: 'search' },
          icon('search'),
          h('span', { class: 'visually-hidden' }, t('versions.rechercher_une_version')),
          h('input', {
            id: 'versions-search',
            type: 'search',
            placeholder: t('versions.rechercher_26_21_snapshot'),
            value: query,
            onInput: (e) => update((s) => { s.versions.query = e.target.value; }),
          }),
        ),
        h(
          'div',
          { role: 'group', 'aria-label': t('versions.filtres'), style: 'display:flex;gap:6px' },
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
