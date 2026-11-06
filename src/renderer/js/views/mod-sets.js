// Ensembles de mods : rangée au-dessus de la liste des mods installés, et fenêtres nommer / supprimer.
import { t } from '../i18n.js';
import { h, icon } from '../dom.js';
import { modSetCount, openModSetDelete, openModSetDialog, removeModSet, saveModSet, selectModSet } from '../mods-actions.js';
import { state, update } from '../state.js';
import { dialog } from './modals.js';

const closeModal = () => update((s) => { s.modal = null; });

/** Rangée « Tout · ensembles · Nouvel ensemble », seulement pour les mods d'une instance avec loader. */
export function modSetsBar(instance, items, running) {
  const sets = instance.modSets ?? [];
  const active = sets.find((s) => s.id === instance.activeModSet) ?? null;
  const locked = running || Boolean(state.mods.busy['*sets*']);
  const chip = (label, count, on, onClick) =>
    h('button', { class: 'chip set-chip', 'aria-pressed': on ? 'true' : 'false', disabled: locked, onClick }, label, count != null && h('span', { class: 'chip__count' }, count));

  return h(
    'div',
    { class: 'set-bar' },
    h(
      'div',
      { class: 'set-bar__row', role: 'group', 'aria-label': t('mod_sets.ensembles_de_mods') },
      chip(t('common.tout'), items.length, !active, () => active && selectModSet(instance, null)),
      sets.map((set) => chip(set.name, modSetCount(set, items), set.id === active?.id, () => set.id !== active?.id && selectModSet(instance, set.id))),
      h('button', { class: 'chip set-chip', disabled: running, onClick: () => openModSetDialog(instance) }, icon('plus', 15), t('mod_sets.nouvel_ensemble')),
    ),
    running
      ? h('p', { class: 'hint set-bar__note' }, t('mod_sets.le_jeu_est_lance_change'))
      : h(
          'p',
          { class: 'hint set-bar__note' },
          active
            ? t('mod_sets.ensemble_actif_mods_sur_les', { name: active.name, items: items.filter((i) => i.enabled).length, items2: items.length })
            : sets.length
              ? t('mod_sets.tous_les_mods_sont_actifs')
              : t('mod_sets.un_ensemble_garde_la_liste'),
          active && [
            ' ',
            h('button', { class: 'link-btn', disabled: locked, onClick: () => openModSetDialog(instance, active) }, t('mod_sets.renommer')),
            ' · ',
            h('button', { class: 'link-btn', disabled: locked, onClick: () => openModSetDelete(instance, active) }, t('mod_sets.supprimer_ensemble')),
          ],
        ),
  );
}

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
