// Fond choisi par instance : ouverture de la fenêtre, choix de l'image, annulation et enregistrement.
import { t } from './i18n.js';
import { refreshInstances } from './actions.js';
import { api } from './api.js';
import { fondUrl, minimumDim, renderScene } from './scene.js';
import { state, toast, toastError, update } from './state.js';

export function openBackground(instance) {
  const saved = instance.background ?? { kind: 'sunset', dim: 0 };
  const modal = {
    type: 'background',
    instanceId: instance.id,
    back: state.modal, // la fenêtre « Modifier l'instance », rouverte à la fermeture
    draft: { kind: saved.kind, dim: saved.dim ?? 0, image: saved.image ?? null },
    min: 0,
    picked: false,
    error: null,
  };
  update((s) => { s.modal = modal; });
  if (saved.kind === 'image' && saved.image) measure(modal);
}

/** Calcule l'assombrissement minimal de l'image choisie, puis l'impose au curseur. */
function measure(modal) {
  const image = modal.draft.image;
  minimumDim(fondUrl(modal.instanceId, image)).then(
    (min) => {
      if (state.modal !== modal || modal.draft.image !== image) return;
      update(() => { modal.min = min; modal.draft.dim = Math.max(modal.draft.dim, min); });
    },
    () => {},
  );
}

export function chooseKind(modal, kind) {
  update(() => {
    modal.draft.kind = kind;
    modal.error = null;
  });
}

/** Sélecteur de fichier (processus principal) : l'image est copiée dans le dossier de l'instance. */
export async function chooseImage(modal) {
  try {
    const name = await api.pickBackground(modal.instanceId);
    if (!name) return;
    update(() => {
      modal.draft.kind = 'image';
      modal.draft.image = name;
      modal.picked = true;
      modal.min = 0;
      modal.error = null;
    });
    measure(modal);
  } catch (error) {
    update(() => { modal.error = error.message; });
  }
}

export function setDim(modal, value) {
  modal.draft.dim = Math.max(Number(value), modal.draft.kind === 'image' ? modal.min : 0);
  renderScene();
}

/** Annuler : le décor revient à celui enregistré, l'image copiée mais non enregistrée est supprimée. */
export function cancelBackground(modal) {
  if (modal.picked) api.cleanBackground(modal.instanceId).catch(() => {});
  update((s) => { s.modal = modal.back; });
}

export async function saveBackground(modal) {
  const { kind, image } = modal.draft;
  const dim = kind === 'image' ? Math.max(modal.draft.dim, modal.min) : modal.draft.dim;
  // Coucher sans assombrissement = le décor d'origine : on n'enregistre rien.
  const background = kind === 'sunset' && dim === 0 ? null : { kind, dim, ...(kind === 'image' ? { image } : {}) };
  try {
    await api.updateInstance(modal.instanceId, { background });
    await refreshInstances();
    update((s) => { s.modal = modal.back; });
    toast({ kind: 'success', title: t('background.fond_enregistre') });
  } catch (error) {
    toastError(t('background.fond_non_enregistre'), error);
  }
}
