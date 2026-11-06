// Menu Cristal : état affiché dans les paramètres de l'instance et demandes au processus principal.
import { t } from './i18n.js';
import { api } from './api.js';
import { state, toast, toastError, update } from './state.js';

const pending = new Set();

function store(id, patch) {
  update((s) => {
    s.titleMenu = { ...s.titleMenu, [id]: { ...s.titleMenu?.[id], ...patch } };
  });
}

export async function loadTitleMenu(id) {
  if (pending.has(id)) return;
  pending.add(id);
  try {
    store(id, await api.titleMenuStatus(id));
  } catch (error) {
    toastError(t('titlemenu.erreur'), error);
  } finally {
    pending.delete(id);
  }
}

/** Enregistre un réglage ; une fois le menu actif, le fichier du jeu suit aussitôt. */
async function change(id, patch) {
  const before = state.titleMenu[id];
  store(id, patch);
  if (!before.active) return;
  try {
    store(id, await api.titleMenuApply(id, { style: state.titleMenu[id].style, card: state.titleMenu[id].card }));
  } catch (error) {
    store(id, { style: before.style, card: before.card });
    toastError(t('titlemenu.erreur'), error);
  }
}

export const setTitleMenuStyle = (id, style) => change(id, { style });
export const setTitleMenuCard = (id, card) => change(id, { card });

export async function enableTitleMenu(id) {
  const { style, card } = state.titleMenu[id];
  store(id, { busy: true });
  try {
    store(id, { ...(await api.titleMenuApply(id, { style, card })), busy: false });
    toast({ kind: 'success', title: t('titlemenu.active'), text: t('titlemenu.active_texte') });
  } catch (error) {
    store(id, { busy: false });
    toastError(t('titlemenu.erreur'), error);
  }
}

export async function disableTitleMenu(id) {
  store(id, { busy: true });
  try {
    store(id, { ...(await api.titleMenuDisable(id)), busy: false });
    toast({ kind: 'success', title: t('titlemenu.retire'), text: t('titlemenu.retire_texte') });
  } catch (error) {
    store(id, { busy: false });
    toastError(t('titlemenu.erreur'), error);
  }
}
