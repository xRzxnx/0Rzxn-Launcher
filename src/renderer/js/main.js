// Point d'entrée de l'interface : redessine tout à chaque changement d'état,
// en conservant le focus, la saisie en cours et la position de défilement.
// Les écrans migrés vers Preact (PREACT_VIEWS) ne sont pas reconstruits : Preact ne change que ce qui a bougé.
import { renderModal, renderWelcome } from './views/modals.js';
import { renderToasts } from './views/toasts.js';
import { renderSidebar, renderTabs, renderTitlebarUpdate, renderTopbarRight } from './views/chrome.js';
import { renderConsole } from './views/console.js';
import { renderHome } from './views/home.js';
import { renderSettings } from './views/settings.js';
import { renderMods } from './views/mods.js';
import { renderVersions } from './views/versions.js';
import { renderWorlds } from './views/worlds.js';
import { renderSidebarMenu } from './views/resume.js';
import { handleShortcut } from './shortcuts.js';
import { init } from './actions.js';
import { checkOtherInstances } from './mods-actions.js';
import { renderScene } from './scene.js';
import { h } from './dom.js';
import { mount, unmount } from './ui.js';
import { t } from './i18n.js';
import { state, subscribe } from './state.js';

const $ = (id) => document.getElementById(id);

const VIEWS = {
  home: renderHome,
  mods: renderMods,
  worlds: renderWorlds,
  versions: renderVersions,
  console: renderConsole,
  settings: renderSettings,
};
const FLUSH_VIEWS = new Set(['versions', 'console', 'mods', 'worlds']);
const PREACT_VIEWS = new Set(['console', 'home', 'mods']);

let lastView = null;

function loadingView() {
  if (!state.loadError) return h('div', { class: 'empty' }, h('p', { class: 'empty__text' }, t('common.chargement')));
  return h(
    'div',
    { class: 'empty' },
    h('h1', { class: 'empty__title' }, t('main.le_launcher_pas_pu_demarrer')),
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
  if (state.modal?.type === 'palette') {
    // La palette garde toujours le focus dans son champ, et la ligne choisie au clavier reste visible.
    const field = document.getElementById('palette-input');
    if (field && snap.focus?.id !== 'palette-input') field.focus({ preventScroll: true });
    if (state.modal.reveal) {
      document.querySelector('[data-reveal]')?.scrollIntoView({ block: 'nearest' });
      state.modal.reveal = false;
    }
  }
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

  renderScene();
  $('tabs').setAttribute('aria-label', t('chrome.tabs_label'));
  $('sidebar').setAttribute('aria-label', t('common.instances'));
  $('titlebar-update').replaceChildren(...renderTitlebarUpdate());
  $('tabs').replaceChildren(...renderTabs());
  $('topbar-right').replaceChildren(...renderTopbarRight());
  $('sidebar').replaceChildren(...renderSidebar().filter(Boolean));

  const main = $('main');
  main.classList.toggle('main--flush', FLUSH_VIEWS.has(state.view) && state.ready);
  if (state.ready && PREACT_VIEWS.has(state.view)) mount(main, VIEWS[state.view]());
  else {
    unmount(main);
    main.replaceChildren(state.ready ? VIEWS[state.view]() : loadingView());
  }

  const overlays = [renderWelcome(), renderModal() ?? renderSidebarMenu()].filter(Boolean);
  $('modal-root').replaceChildren(...overlays);
  mount($('toasts'), renderToasts());

  restore(snap, sameView);
}

document.addEventListener('keydown', handleShortcut);

subscribe(render);
render();
init().then(() => setTimeout(() => checkOtherInstances().catch(() => {}), 4000));
