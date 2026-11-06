// Fenêtre « Skin et cape » : charge l'état du compte et applique les changements.
import { t } from './i18n.js';
import { refreshAccounts } from './actions.js';
import { api } from './api.js';
import { state, toast, toastError, update } from './state.js';

const FRONT = { yaw: -28, pitch: 8 };
const BACK = { yaw: 152, pitch: 8 };

export const currentSkin = (modal) => modal.data?.account?.look?.skin ?? null;
export const activeCapeId = (modal) => modal.data?.account?.look?.capes?.find((c) => c.active)?.id ?? null;

/** Le skin affiché au départ : celui du compte, sinon le premier de « Mes skins ». */
function firstPick(data) {
  const skin = data.account?.look?.skin;
  if (skin) return skin.libraryId ? { kind: 'library', id: skin.libraryId } : { kind: 'current' };
  return data.library[0] ? { kind: 'library', id: data.library[0].id } : null;
}

function variantOf(modal, pick) {
  if (pick?.kind === 'library') return modal.data.library.find((s) => s.id === pick.id)?.variant ?? 'classic';
  return currentSkin(modal)?.variant ?? 'classic';
}

/** Rafraîchit la fenêtre avec un nouvel état ; si `reset`, la sélection repart de ce qui est sur le compte. */
function receive(modal, data, { reset = false } = {}) {
  update(() => {
    modal.data = data;
    modal.loading = false;
    if (reset || !modal.pick) {
      modal.pick = firstPick(data);
      modal.variant = variantOf(modal, modal.pick);
      modal.cape = activeCapeId(modal);
    }
    modal.problem = data.error ? { message: data.error, code: data.errorCode } : null;
  });
}

export async function openSkins(accountId) {
  const modal = { type: 'skins', accountId, data: null, loading: true, pick: null, variant: 'classic', cape: null, view: { ...FRONT }, busy: false, done: false, confirmReset: false, problem: null };
  update((s) => { s.modal = modal; });
  try {
    const data = await api.skinState(accountId);
    if (state.modal !== modal) return;
    receive(modal, data, { reset: true });
    await refreshAccounts();
  } catch (error) {
    update(() => {
      modal.loading = false;
      modal.problem = { message: error.message };
    });
  }
}

export function viewSide(modal, side) {
  update(() => { Object.assign(modal.view, side === 'back' ? BACK : FRONT); });
}

export function pickSkin(modal, pick) {
  update(() => {
    modal.pick = pick;
    modal.variant = variantOf(modal, pick);
    modal.done = false;
    modal.confirmReset = false;
  });
}

export function pickCape(modal, id) {
  update(() => {
    modal.cape = id;
    modal.done = false;
  });
}

export function setVariant(modal, variant) {
  update(() => {
    modal.variant = variant;
    modal.done = false;
  });
  if (modal.pick?.kind !== 'library') return;
  api.setSkinVariant(modal.pick.id, variant).then(
    (library) => update(() => { modal.data.library = library; }),
    (error) => toastError(t('skins.modele_non_enregistre'), error),
  );
}

function addedToLibrary(modal, result, label) {
  update(() => {
    modal.data.library = result.library;
    modal.pick = { kind: 'library', id: result.id };
    modal.variant = variantOf(modal, modal.pick);
    modal.done = false;
  });
  if (!result.added) toast({ title: t('skins.deja_dans_mes_skins'), text: label });
}

export async function importSkin(modal) {
  try {
    const result = await api.importSkin();
    if (result) addedToLibrary(modal, result, t('skins.ce_fichier_est_deja_dans'));
  } catch (error) {
    toastError(t('skins.skin_non_importe'), error);
  }
}

export async function copyPlayerSkin(modal, input) {
  const name = input.value.trim();
  if (!name || modal.copying) return;
  update(() => { modal.copying = true; });
  try {
    const result = await api.copyPlayerSkin(name);
    input.value = '';
    addedToLibrary(modal, result, t('skins.le_skin_de_est_deja', { name: result.name }));
  } catch (error) {
    toastError(t('skins.skin_non_copie'), error);
  } finally {
    update(() => { modal.copying = false; });
  }
}

export async function removeLibrarySkin(modal, id) {
  try {
    const library = await api.removeSkin(id);
    update(() => {
      modal.data.library = library;
      if (modal.pick?.kind === 'library' && modal.pick.id === id) {
        modal.pick = firstPick({ ...modal.data, account: { look: { skin: currentSkin(modal)?.libraryId === id ? null : currentSkin(modal) } } });
        modal.variant = variantOf(modal, modal.pick);
      }
    });
  } catch (error) {
    toastError(t('skins.skin_non_retire'), error);
  }
}

/** Ce qui diffère du compte, ou null s'il n'y a rien à envoyer. */
export function pendingChange(modal) {
  const current = currentSkin(modal);
  const change = {};
  const samePick = modal.pick?.kind === 'current' || (modal.pick?.kind === 'library' && current?.libraryId === modal.pick.id);
  if (modal.pick && (!samePick || modal.variant !== current?.variant)) {
    change.skin = modal.pick.kind === 'library' ? { library: modal.pick.id } : { texture: current.hash };
    change.variant = modal.variant;
  }
  if (modal.cape !== activeCapeId(modal)) change.cape = modal.cape;
  return Object.keys(change).length ? change : null;
}

export async function applyChange(modal) {
  const change = pendingChange(modal);
  if (!change || modal.busy) return;
  await send(modal, () => api.applySkin(modal.accountId, change));
}

export async function resetSkin(modal) {
  if (!modal.confirmReset) {
    update(() => { modal.confirmReset = true; });
    return;
  }
  await send(modal, () => api.resetSkin(modal.accountId));
}

async function send(modal, request) {
  update(() => {
    modal.busy = true;
    modal.done = false;
    modal.confirmReset = false;
    modal.problem = null;
  });
  try {
    const data = await request();
    receive(modal, data, { reset: true });
    update(() => { modal.done = !data.error; });
    await refreshAccounts();
  } catch (error) {
    update(() => { modal.problem = { message: error.message }; });
  } finally {
    update(() => { modal.busy = false; });
  }
}
