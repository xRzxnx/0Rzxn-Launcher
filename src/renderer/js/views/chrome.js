// Éléments toujours visibles : onglets, compte, barre des instances.
import { openLauncherFolder, requestLaunch } from '../actions.js';
import { api } from '../api.js';
import { unseenCrashes } from '../crash-actions.js';
import { pendingModUpdates } from '../mods-actions.js';
import { LOADER_NAMES, LOADERS } from '../data.js';
import { blockIcon, h, icon } from '../dom.js';
import { openWizard } from '../wizard-actions.js';
import { skinHead } from '../skin-view.js';
import { activeAccount, instanceStatus, state, update } from '../state.js';

export const TABS = [
  { id: 'home', label: 'Accueil', icon: 'home' },
  { id: 'mods', label: 'Mods', icon: 'mods' },
  { id: 'versions', label: 'Versions', icon: 'versions' },
];
// Onglets propres à une instance : on y reste quand on change d'instance dans la barre latérale.
const INSTANCE_VIEWS = new Set(['mods']);

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
  openWizard(version);
}

function instanceItem(instance) {
  const status = instanceStatus(instance);
  const updates = pendingModUpdates(instance).length;
  const current = instance.id === state.selectedId && (state.view === 'home' || INSTANCE_VIEWS.has(state.view));
  // Lancer depuis la barre : seulement s'il y a un compte et qu'aucune partie ne tourne.
  const canPlay = Boolean(activeAccount()) && !state.run;
  const select = (s) => { s.selectedId = instance.id; s.view = INSTANCE_VIEWS.has(s.view) ? s.view : 'home'; };
  return h(
    'div',
    { class: 'instance-row' },
    h(
      'button',
      {
        class: 'instance-item',
        'aria-current': current ? 'true' : null,
        onClick: () => update(select),
      },
      blockIcon(instance.icon, '', status.kind === 'idle' ? null : status.kind),
      h(
        'span',
        { style: 'min-width:0' },
        h(
          'span',
          { class: 'instance-item__line' },
          h('span', { class: 'instance-item__name' }, instance.name),
          updates > 0 &&
            h('span', { class: 'up-count', 'aria-label': `${updates} mise${updates > 1 ? 's' : ''} à jour de mods disponible${updates > 1 ? 's' : ''}`, title: `${updates} mise${updates > 1 ? 's' : ''} à jour de mods` }, updates),
        ),
        h(
          'span',
          { class: `instance-item__status instance-item__status--${status.kind}` },
          status.kind === 'busy' || status.kind === 'running' ? status.label : `${instance.version} · ${status.label}`,
        ),
      ),
    ),
    canPlay &&
      h(
        'button',
        {
          class: 'instance-play',
          'aria-label': `Jouer à ${instance.name}`,
          title: instance.installed ? 'Jouer' : `Installer ${instance.version} puis jouer`,
          onClick: () => {
            update(select);
            requestLaunch();
          },
        },
        icon('play'),
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

const loaderOf = (instance) => (LOADERS.includes(instance.loader) ? instance.loader : 'vanilla');

/**
 * Du plus récent au plus ancien : ordre officiel de Mojang (snapshots compris), sinon numéros
 * comparés (version personnalisée, liste pas encore chargée). À version égale, dernière partie d'abord.
 */
function newestFirst(instances) {
  const rank = new Map(state.versions.list.map((v, i) => [v.id, i]));
  return [...instances].sort((a, b) => {
    const order = rank.has(a.version) && rank.has(b.version)
      ? rank.get(a.version) - rank.get(b.version)
      : String(b.version).localeCompare(String(a.version), 'en', { numeric: true });
    return order || (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0) || a.name.localeCompare(b.name, 'fr');
  });
}

/**
 * Une catégorie par loader, vides masquées : [{ name, loader, items }].
 * Une seule liste sans nom pendant une recherche.
 */
function sidebarGroups() {
  const query = state.sidebar.query.trim();
  if (query) return [{ name: null, items: newestFirst(state.instances.filter((i) => matches(i, query))) }];
  return LOADERS
    .map((loader) => ({ name: LOADER_NAMES[loader], loader, items: newestFirst(state.instances.filter((i) => loaderOf(i) === loader)) }))
    .filter((group) => group.items.length > 0);
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
  return groups.map(({ name, loader, items }) => {
    const open = !state.sidebar.collapsed.includes(name);
    const holdsSelected = !open && items.some((i) => i.id === state.selectedId);
    return h(
      'div',
      { class: 'sidebar__group', role: 'group', 'aria-label': name },
      h(
        'button',
        { class: 'group-head', 'aria-expanded': open ? 'true' : 'false', onClick: () => toggleGroup(name) },
        h('span', { class: `group-head__pip loader--${loader}`, 'aria-hidden': 'true' }),
        h('span', { class: 'group-head__name' }, name),
        holdsSelected && h('span', { class: 'group-head__mark', title: 'Instance sélectionnée', 'aria-label': 'Contient l’instance sélectionnée' }),
        h('span', { class: 'group-head__count' }, items.length),
        icon('chevron'),
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
      h('h2', { class: 'sidebar__title' }, 'Instances'),
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
    h('p', { class: 'sidebar__version' }, `Version ${state.appVersion ?? ''}`),
  ];
}
