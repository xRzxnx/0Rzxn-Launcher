// Onglet Notes de version : flux officiel de Mojang (launchercontent.mojang.com), texte affiché tel quel.
import { noteBody, versionDetails } from '../actions.js';
import { bannerUrl } from '../banner.js';
import { formatDateLong, formatDateShort } from '../data.js';
import { h, icon } from '../dom.js';
import { sanitizeHtml } from '../sanitize.js';
import { state, update } from '../state.js';
import { openNewInstance } from './chrome.js';

const FILTERS = [
  { id: 'all', label: 'Tout' },
  { id: 'release', label: 'Releases' },
  { id: 'snapshot', label: 'Snapshots' },
];

const typeLabel = (type) => (type === 'release' ? 'RELEASE' : 'SNAPSHOT');

// Le HTML nettoyé est gardé en cache : on ne le reconstruit pas à chaque redessin.
const bodyCache = new Map();

function body(entry) {
  const result = noteBody(entry);
  if (result === null) {
    return h('div', { class: 'skeleton', 'aria-label': 'Chargement' }, h('div', { class: 'skeleton__h', style: 'width:42%' }), [100, 94, 81].map((w) => h('div', { class: 'skeleton__l', style: `width:${w}%` })));
  }
  if (result.error) return h('p', { class: 'hint hint--error' }, `Impossible de charger cette note : ${result.error}`);
  if (!bodyCache.has(entry.id)) bodyCache.set(entry.id, sanitizeHtml(result.html));
  return h('div', { class: 'prose' }, bodyCache.get(entry.id).cloneNode(true));
}

function list() {
  const { filter, selected } = state.notes;
  const items = state.notes.list.filter((n) => filter === 'all' || n.type === filter);
  return h(
    'aside',
    { class: 'notes-list', 'aria-label': 'Liste des notes' },
    h(
      'div',
      { class: 'notes-list__filters', role: 'group', 'aria-label': 'Filtre' },
      FILTERS.map((f) => h('button', { class: 'chip', 'aria-pressed': filter === f.id ? 'true' : 'false', onClick: () => update((s) => { s.notes.filter = f.id; }) }, f.label)),
    ),
    h(
      'div',
      { class: 'notes-list__items', 'data-scroll-key': 'notes-list' },
      state.notes.loading && h('p', { class: 'hint', style: 'padding:12px' }, 'Chargement des notes…'),
      state.notes.error && h('p', { class: 'hint hint--error', style: 'padding:12px' }, state.notes.error),
      items.map((n) =>
        h(
          'button',
          { class: 'note-item', 'aria-selected': n.id === selected ? 'true' : 'false', onClick: () => update((s) => { s.notes.selected = n.id; }) },
          h('span', { class: 'note-item__meta' }, h('span', { class: `tag tag--${n.type}` }, typeLabel(n.type)), h('span', { class: 'note-item__date' }, formatDateShort(n.date))),
          h('span', { class: 'note-item__title' }, n.title),
        ),
      ),
    ),
  );
}

export function renderNotes() {
  const entry = state.notes.list.find((n) => n.id === state.notes.selected);
  if (!entry) return h('div', { style: 'display:flex;height:100%' }, list());
  const details = state.versions.list.some((v) => v.id === entry.version) ? versionDetails(entry.version) : null;
  const playable = state.versions.list.some((v) => v.id === entry.version);

  return h(
    'div',
    { style: 'display:flex;height:100%' },
    list(),
    h(
      'article',
      { class: 'article', 'data-scroll-key': `note-${entry.id}` },
      h(
        'section',
        { class: 'hero' },
        h('img', { class: 'hero__art', src: bannerUrl(entry.version.length * 13 + 3), alt: '' }),
        h('div', { class: 'hero__info' }, h('span', { class: `tag tag--${entry.type}` }, typeLabel(entry.type)), h('h1', { class: 'hero__title' }, entry.title)),
      ),
      h(
        'div',
        { class: 'article__body' },
        h(
          'div',
          { class: 'article__bar' },
          h('span', { class: 'hero__when' }, `${formatDateLong(entry.date)}${details ? ` · Java ${details.java}` : ''}`),
          h('span', { style: 'flex:1' }),
          playable && h('button', { class: 'btn btn--primary', onClick: () => openNewInstance(entry.version) }, icon('plus'), 'Jouer à cette version'),
        ),
        h('p', { class: 'notice' }, icon('info'), 'Texte officiel de Mojang, affiché tel quel (en anglais).'),
        body(entry),
      ),
    ),
  );
}
