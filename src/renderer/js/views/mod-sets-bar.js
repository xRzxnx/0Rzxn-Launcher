// Ensembles de mods : rangée « Tout · ensembles · Nouvel ensemble » au-dessus de la liste des mods installés.
// Écran Preact (ui.js), comme l'onglet Mods ; les fenêtres nommer / supprimer restent dans mod-sets.js.
import { t } from '../i18n.js';
import { h, icon } from '../ui.js';
import { modSetCount, openModSetDelete, openModSetDialog, selectModSet } from '../mods-actions.js';
import { state } from '../state.js';

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
