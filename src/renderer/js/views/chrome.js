// Éléments toujours visibles : onglets, compte, barre des instances.
import { openLauncherFolder } from '../actions.js';
import { api } from '../api.js';
import { unseenCrashes } from '../crash-actions.js';
import { LOADER_NAMES } from '../data.js';
import { blockIcon, h, icon } from '../dom.js';
import { skinHead } from '../skin-view.js';
import { activeAccount, instanceStatus, state, update } from '../state.js';

export const TABS = [
  { id: 'home', label: 'Accueil', icon: 'home' },
  { id: 'mods', label: 'Mods', icon: 'mods' },
  { id: 'worlds', label: 'Mondes', icon: 'worlds' },
  { id: 'servers', label: 'Serveurs', icon: 'servers' },
  { id: 'screenshots', label: 'Captures', icon: 'screenshots' },
  { id: 'versions', label: 'Versions', icon: 'versions' },
  { id: 'notes', label: 'Notes', icon: 'notes' },
];
// Onglets propres à une instance : on y reste quand on change d'instance dans la barre latérale.
const INSTANCE_VIEWS = new Set(['mods', 'worlds', 'servers', 'screenshots']);
const NO_GROUP = 'Sans groupe';

export function go(view) {
  update((s) => {
    s.view = view;
  });
}

export function renderTabs() {
  return TABS.map((tab) =>
    h(
      'button',
      { class: 'tab', 'aria-current': state.view === tab.id ? 'page' : null, onClick: () => go(tab.id) },
      icon(tab.icon),
      tab.label,
    ),
  );
}

export function renderTopbarRight() {
  const account = activeAccount();
  return [
    h(
      'button',
      {
        class: 'account-chip',
        onClick: () => update((s) => { s.modal = { type: 'accounts' }; }),
        'aria-label': account ? `Comptes : ${account.name}` : 'Comptes',
      },
      account ? skinHead(account, 30) : h('span', { class: 'avatar', style: 'width:30px;height:30px;background:var(--line-3)' }),
      h(
        'span',
        null,
        h('span', { class: 'account-chip__name' }, account ? account.name : 'Aucun compte'),
        h('span', { class: 'account-chip__type' }, account ? (account.type === 'microsoft' ? 'Compte Microsoft' : 'Hors-ligne') : 'Ajouter un compte'),
      ),
    ),
    h(
      'button',
      {
        class: 'square-btn',
        'aria-label': 'Paramètres',
        'aria-pressed': state.view === 'settings' ? 'true' : 'false',
        onClick: () => go(state.view === 'settings' ? 'home' : 'settings'),
      },
      icon('settings'),
    ),
  ];
}

export function openNewInstance(version) {
  const fallback = state.versions.latest?.release ?? state.versions.list.find((v) => v.type === 'release')?.id ?? '';
  update((s) => {
    s.modal = { type: 'new-instance', draft: { icon: 'grass', name: '', version: typeof version === 'string' ? version : fallback, loader: 'vanilla', loaderVersion: null, group: '', accountId: null } };
  });
}

function instanceItem(instance) {
  const status = instanceStatus(instance);
  const current = instance.id === state.selectedId && (state.view === 'home' || INSTANCE_VIEWS.has(state.view));
  return h(
    'button',
    {
      class: 'instance-item',
      'aria-current': current ? 'true' : null,
      onClick: () => update((s) => { s.selectedId = instance.id; s.view = INSTANCE_VIEWS.has(s.view) ? s.view : 'home'; }),
    },
    blockIcon(instance.icon, '', status.kind === 'idle' ? null : status.kind),
    h(
      'span',
      { style: 'min-width:0' },
      h('span', { class: 'instance-item__name' }, instance.name),
      h(
        'span',
        { class: `instance-item__status instance-item__status--${status.kind}` },
        status.kind === 'busy' || status.kind === 'running' ? status.label : `${instance.version}${instance.loader && instance.loader !== 'vanilla' ? ` · ${LOADER_NAMES[instance.loader]}` : ''} · ${status.label}`,
      ),
    ),
  );
}

/** Nom, version et loader : « fabric 1.21 » trouve les instances Fabric en 1.21.x. */
function matches(instance, query) {
  const haystack = `${instance.name} ${instance.version} ${LOADER_NAMES[instance.loader] ?? ''} ${instance.group ?? ''}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

function toggleGroup(name) {
  update((s) => {
    const collapsed = new Set(s.sidebar.collapsed);
    if (collapsed.has(name)) collapsed.delete(name);
    else collapsed.add(name);
    s.sidebar.collapsed = [...collapsed];
  });
  api.saveUi({ collapsedGroups: state.sidebar.collapsed }).catch(() => {});
}

/**
 * Groupes par ordre alphabétique, « Sans groupe » à la fin : [{ name, items }].
 * Un seul groupe sans nom pendant une recherche, ou tant qu'aucune instance n'a de groupe.
 */
function sidebarGroups() {
  const query = state.sidebar.query.trim();
  if (query) return [{ name: null, items: state.instances.filter((i) => matches(i, query)) }];
  if (!state.instances.some((i) => i.group)) return [{ name: null, items: state.instances }];
  const groups = new Map();
  for (const instance of state.instances) {
    const name = instance.group ?? NO_GROUP;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(instance);
  }
  const names = [...groups.keys()].sort((a, b) => (a === NO_GROUP) - (b === NO_GROUP) || a.localeCompare(b, 'fr'));
  return names.map((name) => ({ name, items: groups.get(name) }));
}

/** Instances visibles dans la barre latérale, dans l'ordre (Alt+↑ / Alt+↓). */
export function visibleInstances() {
  return sidebarGroups().flatMap((g) => (g.name && state.sidebar.collapsed.includes(g.name) ? [] : g.items));
}

export function selectInstance(id) {
  update((s) => { s.selectedId = id; s.view = INSTANCE_VIEWS.has(s.view) ? s.view : 'home'; });
}

function instanceList() {
  const query = state.sidebar.query.trim();
  if (state.instances.length === 0) return h('p', { class: 'hint', style: 'padding:6px 10px' }, 'Aucune instance pour l’instant. Crée la première avec le bouton +.');
  const groups = sidebarGroups();
  if (!groups[0].name) {
    const found = groups[0].items;
    return found.length ? found.map(instanceItem) : h('p', { class: 'hint', style: 'padding:6px 10px' }, `Aucune instance ne correspond à « ${query} ».`);
  }
  return groups.map(({ name, items }) => {
    const open = !state.sidebar.collapsed.includes(name);
    return h(
      'div',
      { class: 'sidebar__group', role: 'group', 'aria-label': name },
      h(
        'button',
        { class: 'group-head', 'aria-expanded': open ? 'true' : 'false', onClick: () => toggleGroup(name) },
        icon('chevron'),
        h('span', { class: 'group-head__name' }, name),
        h('span', { class: 'group-head__count' }, items.length),
      ),
      open && items.map(instanceItem),
    );
  });
}

export function focusSearch() {
  const input = document.getElementById('instance-search');
  input?.focus();
  input?.select();
}

export function renderSidebar() {
  const running = state.run?.phase === 'running';
  const crashes = unseenCrashes();
  return [
    h(
      'div',
      { class: 'sidebar__head' },
      h('h2', { class: 'label', style: 'margin:0;font-size:12px' }, 'Instances'),
      h('button', { class: 'sidebar__add', 'aria-label': 'Nouvelle instance', onClick: openNewInstance }, icon('plus')),
    ),
    state.instances.length > 1 &&
      h(
        'label',
        { class: 'sidebar__search' },
        icon('search'),
        h('span', { class: 'visually-hidden' }, 'Rechercher une instance'),
        h('input', {
          id: 'instance-search',
          type: 'search',
          placeholder: 'Rechercher…',
          value: state.sidebar.query,
          onInput: (e) => update((s) => { s.sidebar.query = e.target.value; }),
          onKeydown: (e) => {
            if (e.key === 'Escape') update((s) => { s.sidebar.query = ''; });
            if (e.key === 'Enter') {
              const first = state.instances.find((i) => matches(i, state.sidebar.query));
              if (first) update((s) => { s.selectedId = first.id; s.view = INSTANCE_VIEWS.has(s.view) ? s.view : 'home'; });
            }
          },
        }),
        h('kbd', { class: 'sidebar__kbd' }, 'Ctrl F'),
      ),
    h('div', { class: 'sidebar__list', 'data-scroll-key': 'sidebar' }, instanceList()),
    h(
      'div',
      { class: 'sidebar__foot' },
      h(
        'button',
        { class: 'side-link', 'aria-current': state.view === 'console' ? 'page' : null, onClick: () => go('console') },
        icon('console'),
        'Console',
        running && h('span', { class: 'side-link__dot', 'aria-label': 'Jeu en cours' }),
        crashes > 0 && h('span', { class: 'count-badge count-badge--danger', 'aria-label': `${crashes} nouveau${crashes > 1 ? 'x' : ''} rapport${crashes > 1 ? 's' : ''} de crash` }, crashes),
      ),
      h('button', { class: 'side-link', onClick: openLauncherFolder }, icon('folder'), 'Dossier du launcher'),
    ),
    h('p', { class: 'sidebar__version' }, `LAUNCHER ${state.appVersion ?? ''}`),
  ];
}
