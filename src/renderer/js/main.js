// Point d'entrée de l'interface : redessine tout à chaque changement d'état,
// en conservant le focus, la saisie en cours et la position de défilement.
import { renderModal, renderToasts, renderWelcome } from './views/modals.js';
import { renderSidebar, renderTabs, renderTopbarRight } from './views/chrome.js';
import { renderConsole } from './views/console.js';
import { renderHome } from './views/home.js';
import { renderNotes } from './views/notes.js';
import { renderSettings } from './views/settings.js';
import { renderMods } from './views/mods.js';
import { renderServers } from './views/servers.js';
import { renderVersions } from './views/versions.js';
import { renderWorlds } from './views/worlds.js';
import { renderScreenshots } from './views/screenshots.js';
import { handleShortcut } from './shortcuts.js';
import { init } from './actions.js';
import { h } from './dom.js';
import { state, subscribe } from './state.js';

const $ = (id) => document.getElementById(id);

const VIEWS = {
  home: renderHome,
  mods: renderMods,
  worlds: renderWorlds,
  servers: renderServers,
  screenshots: renderScreenshots,
  versions: renderVersions,
  notes: renderNotes,
  console: renderConsole,
  settings: renderSettings,
};
const FLUSH_VIEWS = new Set(['versions', 'notes', 'console', 'mods', 'servers', 'worlds', 'screenshots']);

let lastView = null;

function loadingView() {
  if (!state.loadError) return h('div', { class: 'empty' }, h('p', { class: 'empty__text' }, 'Chargement…'));
  return h(
    'div',
    { class: 'empty' },
    h('h1', { class: 'empty__title' }, 'Le launcher n’a pas pu démarrer'),
    h('p', { class: 'empty__text' }, state.loadError),
  );
}

function snapshot() {
  const active = document.activeElement;
  const focus = active?.id
    ? { id: active.id, start: active.selectionStart ?? null, end: active.selectionEnd ?? null }
    : null;
  const scroll = {};
  document.querySelectorAll('[data-scroll-key]').forEach((el) => {
    scroll[el.dataset.scrollKey] = el.scrollTop;
  });
  const kept = {};
  document.querySelectorAll('input[data-keep][id]').forEach((el) => {
    kept[el.id] = el.value;
  });
  return { focus, scroll, kept, mainScroll: $('main').scrollTop };
}

function restore(snap, sameView) {
  for (const [id, value] of Object.entries(snap.kept)) {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = value;
  }
  document.querySelectorAll('[data-scroll-key]').forEach((el) => {
    if (el.dataset.autoscroll) el.scrollTop = el.scrollHeight;
    else if (sameView && snap.scroll[el.dataset.scrollKey] != null) el.scrollTop = snap.scroll[el.dataset.scrollKey];
    else {
      // Premier affichage : la ligne marquée (erreur d'un rapport de crash) est mise à l'écran.
      const first = el.querySelector('[data-scroll-first]');
      if (first) el.scrollTop = Math.max(0, first.offsetTop - el.clientHeight / 3);
    }
  });
  if (sameView) $('main').scrollTop = snap.mainScroll;
  if (snap.focus) {
    const el = document.getElementById(snap.focus.id);
    if (el) {
      el.focus({ preventScroll: true });
      if (snap.focus.start != null && typeof el.setSelectionRange === 'function') {
        try {
          el.setSelectionRange(snap.focus.start, snap.focus.end);
        } catch {
          // certains types de champs (number) ne gèrent pas la sélection
        }
      }
    }
  }
}

function render() {
  const snap = snapshot();
  const sameView = lastView === state.view;
  lastView = state.view;

  $('tabs').replaceChildren(...renderTabs());
  $('topbar-right').replaceChildren(...renderTopbarRight());
  $('sidebar').replaceChildren(...renderSidebar().filter(Boolean));

  const main = $('main');
  main.classList.toggle('main--flush', FLUSH_VIEWS.has(state.view) && state.ready);
  if (state.ready) main.replaceChildren(VIEWS[state.view]());
  else main.replaceChildren(loadingView());

  const overlays = [renderWelcome(), renderModal()].filter(Boolean);
  $('modal-root').replaceChildren(...overlays);
  $('toasts').replaceChildren(...renderToasts());

  restore(snap, sameView);
}

document.addEventListener('keydown', handleShortcut);

subscribe(render);
render();
init();
