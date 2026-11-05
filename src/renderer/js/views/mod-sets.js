// Ensembles de mods : rangée au-dessus de la liste des mods installés, et fenêtres nommer / supprimer.
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
      { class: 'set-bar__row', role: 'group', 'aria-label': 'Ensembles de mods' },
      chip('Tout', items.length, !active, () => active && selectModSet(instance, null)),
      sets.map((set) => chip(set.name, modSetCount(set, items), set.id === active?.id, () => set.id !== active?.id && selectModSet(instance, set.id))),
      h('button', { class: 'chip set-chip', disabled: running, onClick: () => openModSetDialog(instance) }, icon('plus', 15), 'Nouvel ensemble'),
    ),
    running
      ? h('p', { class: 'hint set-bar__note' }, 'Le jeu est lancé : change d’ensemble une fois la partie terminée.')
      : h(
          'p',
          { class: 'hint set-bar__note' },
          active
            ? `Ensemble « ${active.name} » actif : ${items.filter((i) => i.enabled).length} mods sur ${items.length}. Les autres restent installés et reviennent en un clic.`
            : sets.length
              ? 'Tous les mods sont actifs. Choisis un ensemble pour n’activer que les siens.'
              : 'Un ensemble garde la liste des mods actifs du moment : crée-en un, puis bascule entre eux sans rien désinstaller.',
          active && [
            ' ',
            h('button', { class: 'link-btn', disabled: locked, onClick: () => openModSetDialog(instance, active) }, 'Renommer'),
            ' · ',
            h('button', { class: 'link-btn', disabled: locked, onClick: () => openModSetDelete(instance, active) }, 'Supprimer l’ensemble'),
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
      error.textContent = 'Donne un nom à ton ensemble.';
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
    title: set ? 'Renommer l’ensemble' : 'Nouvel ensemble',
    size: 'dialog--small',
    labelId: 'mod-set-title',
    body: [
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'label', for: 'mod-set-name' }, 'Nom'),
        h('input', {
          id: 'mod-set-name',
          class: 'input',
          type: 'text',
          maxlength: 30,
          placeholder: 'PvP, Exploration…',
          value: modal.name,
          autofocus: true,
          onInput: (e) => { modal.name = e.target.value; error.textContent = ''; },
          onKeydown: (e) => e.key === 'Enter' && submit(),
        }),
      ),
      !set && h('p', { class: 'hint' }, 'L’ensemble démarre avec les mods actifs en ce moment. Les autres mods restent installés.'),
      error,
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: closeModal }, 'Annuler'),
      h('button', { class: 'btn btn--primary btn--lg', onClick: submit }, set ? 'Renommer' : 'Créer'),
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
    title: 'Supprimer l’ensemble ?',
    size: 'dialog--small',
    labelId: 'mod-set-del-title',
    body: [
      h('p', { style: 'margin:0;font-size:14px;line-height:1.6;color:var(--text-3)' }, `« ${set.name} » disparaît de la liste. Aucun mod n’est supprimé, activé ou désactivé : ils restent comme ils sont.`),
      error,
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: closeModal }, 'Annuler'),
      h('button', { class: 'btn btn--lg btn--danger', onClick: confirm }, 'Supprimer l’ensemble'),
    ],
  });
}
