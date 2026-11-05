// Raccourcis clavier du launcher. Les chiffres sont lus par position (Digit1…) pour marcher en AZERTY.
import { requestLaunch } from './actions.js';
import { togglePalette } from './palette-actions.js';
import { activeAccount, selectedInstance, state, update } from './state.js';
import { focusSearch, go, openNewInstance, selectInstance, TABS, visibleInstances } from './views/chrome.js';

export const SHORTCUTS = [
  {
    title: 'Jouer',
    rows: [
      { label: "Jouer à l'instance sélectionnée", keys: ['Ctrl', 'Entrée'] },
      { label: 'Arrêter le jeu (avec confirmation)', keys: ['Ctrl', 'Maj', 'K'] },
    ],
  },
  {
    title: 'Instances',
    rows: [
      { label: 'Recherche globale', keys: ['Ctrl', 'K'] },
      { label: 'Rechercher dans les instances', keys: ['Ctrl', 'F'] },
      { label: 'Précédente / suivante', keys: ['Alt', '↑', '↓'] },
      { label: 'Nouvelle instance', keys: ['Ctrl', 'N'] },
    ],
  },
  {
    title: 'Navigation',
    rows: [
      { label: 'Onglets Accueil à Versions', keys: ['Ctrl', '1…3'] },
      { label: 'Console', keys: ['Ctrl', 'L'] },
      { label: 'Paramètres', keys: ['Ctrl', ','] },
    ],
  },
  {
    title: 'Fenêtre',
    rows: [
      { label: 'Fermer la fenêtre ouverte', keys: ['Échap'] },
      { label: 'Cette aide', keys: ['Ctrl', '/'] },
    ],
  },
];

const TYPING = new Set(['text', 'search', 'number', 'email', 'url', 'password', 'tel']);
function isTyping(target) {
  if (!target?.closest) return false;
  if (target.closest('textarea, select, [contenteditable="true"]')) return true;
  return target.tagName === 'INPUT' && TYPING.has(target.type);
}

function launchShortcut() {
  if (state.run || !selectedInstance()) return;
  if (!activeAccount()) update((s) => { s.modal = { type: 'accounts' }; });
  else requestLaunch();
}

function stepInstance(delta) {
  const list = visibleInstances();
  if (list.length === 0) return;
  const index = list.findIndex((i) => i.id === state.selectedId);
  const next = list[index < 0 ? 0 : (index + delta + list.length) % list.length];
  selectInstance(next.id);
  document.querySelector('.instance-item[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
}

/** Ctrl / (en AZERTY : Ctrl Maj :, ou le / du pavé numérique), ou F1. */
const isHelp = (e) => e.key === 'F1' || ((e.ctrlKey || e.metaKey) && (e.key === '/' || e.code === 'NumpadDivide'));

export function handleShortcut(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (e.key === 'Escape' && state.modal) {
    update((s) => { s.modal = null; });
    return;
  }
  if (isHelp(e)) {
    e.preventDefault();
    if (state.modal?.type === 'shortcuts') update((s) => { s.modal = null; });
    else if (!state.modal) update((s) => { s.modal = { type: 'shortcuts' }; });
    return;
  }
  // Ctrl+K : recherche globale, depuis n'importe où sauf une autre fenêtre modale.
  if (ctrl && !e.shiftKey && !e.altKey && key === 'k' && (!state.modal || state.modal.type === 'palette')) {
    e.preventDefault();
    togglePalette();
    return;
  }
  if (state.modal || !state.ready) return;
  // Ctrl+F : recherche dans la barre des instances, même depuis un champ.
  if (ctrl && !e.shiftKey && key === 'f') {
    e.preventDefault();
    focusSearch();
    return;
  }
  if (isTyping(e.target)) return;

  if (ctrl && e.key === 'Enter') {
    e.preventDefault();
    launchShortcut();
  } else if (ctrl && e.shiftKey && key === 'k') {
    e.preventDefault();
    if (state.run) update((s) => { s.modal = { type: 'stop-game' }; });
  } else if (e.altKey && !ctrl && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    stepInstance(e.key === 'ArrowUp' ? -1 : 1);
  } else if (ctrl && !e.shiftKey && key === 'n') {
    e.preventDefault();
    openNewInstance();
  } else if (ctrl && !e.shiftKey && /^Digit[1-3]$/.test(e.code)) {
    e.preventDefault();
    go(TABS[Number(e.code.slice(5)) - 1].id);
  } else if (ctrl && !e.shiftKey && key === 'l') {
    e.preventDefault();
    go('console');
  } else if (ctrl && e.key === ',') {
    e.preventDefault();
    go('settings');
  }
}
