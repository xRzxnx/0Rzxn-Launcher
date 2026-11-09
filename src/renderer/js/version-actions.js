// Changement de version d'une instance : aperçu de ce que deviennent les mods, packs et shaders, puis application.
import { api } from './api.js';
import { editInstance } from './actions.js';
import { t } from './i18n.js';
import { toast, toastError, update } from './state.js';

/**
 * Appelé quand la fenêtre de modification change la version : calcule le plan et l'affiche.
 * S'il n'y a rien d'actif dans l'instance, la version change directement.
 */
export async function askVersionChange(instance, patch) {
  let plan = null;
  let error = null;
  try {
    plan = await api.versionPlan(instance.id, patch.version);
  } catch (e) {
    error = e.message;
  }
  if (plan && !plan.some((p) => p.fate !== 'same')) {
    await editInstance(instance.id, patch, { planned: true });
    return;
  }
  update((s) => {
    s.modal = { type: 'version-change', instanceId: instance.id, patch, from: instance.version, plan, error, updateOk: true, disableMissing: true, busy: false };
  });
}

export function setVersionOption(key, value) {
  update((s) => {
    if (s.modal?.type === 'version-change') s.modal[key] = value;
  });
}

/** Change la version (sauvegarde automatique des mondes comprise), puis met à jour et désactive ce qui a été choisi. */
export async function runVersionChange(modal) {
  const { instanceId, patch, plan, updateOk, disableMissing } = modal;
  const after = async () => {
    const toUpdate = updateOk ? (plan ?? []).filter((p) => p.fate === 'update') : [];
    const toDisable = disableMissing ? (plan ?? []).filter((p) => p.fate === 'missing') : [];
    let updated = 0;
    let disabled = 0;
    try {
      for (const kind of new Set(toUpdate.map((p) => p.kind))) {
        const files = toUpdate.filter((p) => p.kind === kind).map((p) => p.file);
        const result = await api.updateContent(instanceId, kind, files);
        updated += Array.isArray(result) ? result.length : files.length;
      }
      for (const p of toDisable) {
        await api.toggleContent(instanceId, p.kind, p.file);
        disabled++;
      }
    } catch (error) {
      toastError(t('version.mise_a_jour_incomplete'), error);
    }
    update((s) => {
      for (const key of Object.keys(s.mods.installed)) if (key.startsWith(`${instanceId}:`)) delete s.mods.installed[key];
    });
    if (updated || disabled) toast({ kind: 'success', title: t('version.passee_en', { version: patch.version }), text: t('version.resume', { updated, disabled }) });
  };
  update((s) => {
    if (s.modal?.type === 'version-change') s.modal.busy = true;
  });
  await editInstance(instanceId, patch, { planned: true, after });
}

