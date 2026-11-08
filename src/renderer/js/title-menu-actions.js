// Menu Cristal : état affiché dans les paramètres de l'instance et demandes au processus principal.
import { t } from './i18n.js';
import { api } from './api.js';
import { dismissToast, state, toast, toastError, update } from './state.js';

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

/**
 * Avant un lancement : une instance moddée jamais réglée reçoit le menu Cristal, avec le style
 * choisi dans ses paramètres s'il y en a un. Ne doit jamais empêcher de jouer.
 */
export async function autoTitleMenu(instance) {
  if (instance.titleMenu !== undefined || !instance.loader || instance.loader === 'vanilla') return false;
  const menu = state.titleMenu?.[instance.id];
  // Le message n'apparaît que si l'ajout dure (téléchargement depuis Modrinth).
  let progress = null;
  const timer = setTimeout(() => { progress = toast({ title: t('titlemenu.ajout'), timeout: 0 }); }, 600);
  try {
    const result = await api.titleMenuAuto(instance.id, menu ? { style: menu.style, card: menu.card } : {});
    if (!result.added) return false;
    store(instance.id, await api.titleMenuStatus(instance.id));
    toast({ kind: 'success', title: t('titlemenu.ajoute'), text: t('titlemenu.ajoute_texte') });
    return true;
  } catch {
    return false; // on réessaiera au prochain lancement
  } finally {
    clearTimeout(timer);
    if (progress) dismissToast(progress);
  }
}

export async function disableTitleMenu(id) {
  const wasInstalled = state.titleMenu[id]?.installed;
  store(id, { busy: true });
  try {
    store(id, { ...(await api.titleMenuDisable(id)), busy: false });
    toast({ kind: 'success', title: t('titlemenu.retire'), text: t(wasInstalled ? 'titlemenu.retire_texte' : 'titlemenu.garde_texte') });
  } catch (error) {
    store(id, { busy: false });
    toastError(t('titlemenu.erreur'), error);
  }
}
