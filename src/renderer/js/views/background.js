// Fenêtre « Fond de <instance> » : Coucher, Nuit, Forêt ou une image perso, avec un curseur d'assombrissement.
import { t } from '../i18n.js';
import { bannerUrl } from '../banner.js';
import { cancelBackground, chooseImage, chooseKind, saveBackground, setDim } from '../background-actions.js';
import { h, icon } from '../dom.js';
import { fondUrl } from '../scene.js';
import { state } from '../state.js';
import { dialog } from './modals.js';

const THEMES = () => [['sunset', t('background.coucher')], ['night', t('background.nuit')], ['forest', t('background.foret')]];

export function backgroundDialog(modal) {
  const instance = state.instances.find((i) => i.id === modal.instanceId);
  if (!instance) return null;
  const draft = modal.draft;
  const isImage = draft.kind === 'image';
  const dim = isImage ? Math.max(draft.dim, modal.min) : draft.dim;
  const cancel = () => cancelBackground(modal);

  const thumb = (kind, label, content) =>
    h('button', { class: `bg-thumb${draft.kind === kind ? ' bg-thumb--on' : ''}`, role: 'radio', 'aria-checked': draft.kind === kind ? 'true' : 'false', onClick: content.onClick }, content.art, h('span', { class: 'bg-thumb__label' }, label));

  const value = h('span', { class: 'ram-value' }, `${dim} %`);
  const note = h('p', { class: 'hint' });
  const showNote = () => {
    note.textContent =
      isImage && modal.min > 0
        ? t('background.minimum_pour_cette_image_en', { min: modal.min })
        : t('background.le_launcher_verifie_le_contraste');
  };
  showNote();

  return dialog({
    title: t('common.fond_de', { name: instance.name }),
    size: 'dialog--wide',
    labelId: 'background-title',
    onClose: cancel,
    body: [
      h('p', { class: 'hint', style: 'margin:0' }, t('background.ce_fond_apparait_quand_cette')),
      h(
        'div',
        { class: 'bg-thumbs', role: 'radiogroup', 'aria-label': t('background.fond') },
        THEMES().map(([kind, label]) =>
          thumb(kind, label, { art: h('img', { src: bannerUrl(instance.seed, 320, 150, kind), alt: '' }), onClick: () => chooseKind(modal, kind) }),
        ),
        thumb('image', t('background.mon_image'), {
          art: draft.image ? h('img', { src: fondUrl(instance.id, draft.image), alt: '' }) : h('span', { class: 'bg-thumb__empty' }, icon('upload', 22)),
          onClick: () => (draft.image ? chooseKind(modal, 'image') : chooseImage(modal)),
        }),
      ),
      draft.image && h('div', null, h('button', { class: 'btn', onClick: () => chooseImage(modal) }, icon('upload', 16), t('background.changer_image'))),
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'settings__title-row' }, h('label', { class: 'label', for: 'background-dim' }, t('background.assombrir_pour_garder_le_texte')), value),
        h('input', {
          id: 'background-dim',
          class: 'range',
          type: 'range',
          min: isImage ? modal.min : 0,
          max: 100,
          step: 1,
          value: dim,
          // Aperçu direct sans redessiner la fenêtre, pour garder le curseur en main.
          onInput: (e) => {
            setDim(modal, e.target.value);
            value.textContent = `${Math.max(draft.dim, isImage ? modal.min : 0)} %`;
          },
        }),
        note,
      ),
      h('p', { class: 'hint hint--error', role: 'alert' }, modal.error),
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: cancel }, t('common.annuler')),
      h('button', { class: 'btn btn--primary btn--lg', onClick: () => saveBackground(modal) }, t('common.enregistrer')),
    ],
  });
}
