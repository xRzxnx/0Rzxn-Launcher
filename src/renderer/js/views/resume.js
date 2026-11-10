// Bouton « Reprendre » (accueil) et menu du clic droit sur une instance de la barre latérale :
// entrer directement dans un monde ou sur un serveur joué récemment (Quick Play, Minecraft 1.20 et plus).
import { t } from '../i18n.js';
import { openInstanceFolder, requestLaunch } from '../actions.js';
import { h } from '../dom.js';
import { activeAccount, state, update } from '../state.js';
import { go } from './chrome.js';

/** Mondes et serveurs récents que cette instance sait rejoindre au démarrage. */
export function resumeTargets(instance) {
  // Avant 1.20, le jeu ne sait rejoindre au démarrage qu'un serveur.
  return (instance.recent ?? []).filter((r) => instance.quickPlay || r.type === 'multiplayer');
}

export function resume(instance, target) {
  update((s) => {
    s.selectedId = instance.id;
    s.resumeMenu = null;
    s.sidebarMenu = null;
  });
  requestLaunch({ quickPlay: { type: target.type, id: target.id, name: target.name } });
}

const closeMenus = () => {
  if (state.resumeMenu || state.sidebarMenu) update((s) => { s.resumeMenu = null; s.sidebarMenu = null; });
};

// Un menu ouvert se ferme au clic ailleurs ou avec Échap.
let watching = false;
export function watchOutside() {
  if (watching) return;
  watching = true;
  const stop = () => {
    watching = false;
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
  };
  const onDown = (e) => {
    if (e.target.closest?.('.resume-menu, .resume__more')) return;
    stop();
    closeMenus();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    stop();
    closeMenus();
  };
  setTimeout(() => {
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
  });
}

/** Clic droit sur une instance de la barre latérale. */
export function openSidebarMenu(event, instance) {
  event.preventDefault();
  update((s) => { s.sidebarMenu = { id: instance.id, x: event.clientX, y: event.clientY }; });
  watchOutside();
}

export function renderSidebarMenu() {
  const menu = state.sidebarMenu;
  const instance = menu && state.instances.find((i) => i.id === menu.id);
  if (!instance) return null;
  const canPlay = Boolean(activeAccount()) && !state.run;
  const [first] = resumeTargets(instance);
  const select = () => update((s) => { s.selectedId = instance.id; s.sidebarMenu = null; });
  const item = (label, run, disabled = false, extra = null) =>
    h('button', { class: 'resume-menu__item resume-menu__item--small', role: 'menuitem', disabled, onClick: run }, h('span', { class: 'resume-menu__body' }, h('b', null, label)), extra);
  return h(
      'div',
      { class: 'resume-menu resume-menu--context', role: 'menu', 'aria-label': instance.name, style: `left:${Math.min(menu.x, window.innerWidth - 270)}px;top:${Math.min(menu.y, window.innerHeight - 220)}px` },
      item(t('common.jouer'), () => { select(); requestLaunch(); }, !canPlay),
      first && item(t('resume.reprendre'), () => resume(instance, first), !canPlay || !instance.installed, h('span', { class: 'resume-menu__hint' }, first.name)),
      h('div', { class: 'resume-menu__sep' }),
      item(t('chrome.mondes'), () => { select(); go('worlds'); }),
      item(t('resume.ouvrir_le_dossier'), () => { select(); openInstanceFolder(instance.id); }),
    );
}
