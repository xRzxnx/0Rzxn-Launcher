// Ensembles de mods : fenêtres nommer / supprimer (la rangée au-dessus de la liste est dans mod-sets-bar.js).
import { t } from '../i18n.js';
import { h } from '../dom.js';
import { removeModSet, saveModSet } from '../mods-actions.js';
import { state, update } from '../state.js';
import { dialog } from './modals.js';

const closeModal = () => update((s) => { s.modal = null; });

export function modSetDialog(modal) {
  const instance = state.instances.find((i) => i.id === modal.instanceId);
  if (!instance) return null;
  const set = modal.setId ? (instance.modSets ?? []).find((s) => s.id === modal.setId) : null;
  const error = h('p', { class: 'hint hint--error', role: 'alert' });
  const submit = async () => {
    if (modal.busy) return;
    if (!modal.name.trim()) {
      error.textContent = t('mod_sets.donne_un_nom_ton_ensemble');
      return;
    }
    modal.busy = true;
    try {
      await saveModSet(instance, set?.id ?? null, modal.name);
    } catch (e) {
      modal.busy = false;
      error.textContent = e.message;
    }
  };
  return dialog({
    title: set ? t('mod_sets.renommer_ensemble') : t('mod_sets.nouvel_ensemble'),
    size: 'dialog--small',
    labelId: 'mod-set-title',
    body: [
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'label', for: 'mod-set-name' }, t('common.nom')),
        h('input', {
          id: 'mod-set-name',
          class: 'input',
          type: 'text',
          maxlength: 30,
          placeholder: t('mod_sets.pvp_exploration'),
          value: modal.name,
          autofocus: true,
          onInput: (e) => { modal.name = e.target.value; error.textContent = ''; },
          onKeydown: (e) => e.key === 'Enter' && submit(),
        }),
      ),
      !set && h('p', { class: 'hint' }, t('mod_sets.ensemble_demarre_avec_les_mods')),
      error,
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: closeModal }, t('common.annuler')),
      h('button', { class: 'btn btn--primary btn--lg', onClick: submit }, set ? t('mod_sets.renommer') : t('common.creer')),
    ],
  });
}

export function modSetDeleteDialog(modal) {
  const instance = state.instances.find((i) => i.id === modal.instanceId);
  const set = instance?.modSets?.find((s) => s.id === modal.setId);
  if (!set) return null;
  const error = h('p', { class: 'hint hint--error', role: 'alert' });
  const confirm = async () => {
    if (modal.busy) return;
    modal.busy = true;
    try {
      await removeModSet(instance, set.id);
    } catch (e) {
      modal.busy = false;
      error.textContent = e.message;
    }
  };
  return dialog({
    title: t('mod_sets.supprimer_ensemble_2'),
    size: 'dialog--small',
    labelId: 'mod-set-del-title',
    body: [
      h('p', { style: 'margin:0;font-size:14px;line-height:1.6;color:var(--text-3)' }, t('mod_sets.disparait_de_la_liste_aucun', { name: set.name })),
      error,
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: closeModal }, t('common.annuler')),
      h('button', { class: 'btn btn--lg btn--danger', onClick: confirm }, t('mod_sets.supprimer_ensemble')),
    ],
  });
}
