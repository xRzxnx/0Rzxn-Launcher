// Fenêtre « Skin et cape » d'un compte : aperçu 3D, Mes skins, capes.
import { t } from '../i18n.js';
import { applyChange, copyPlayerSkin, currentSkin, importSkin, pendingChange, pickCape, pickSkin, removeLibrarySkin, resetSkin, setVariant, viewSide } from '../skins-actions.js';
import { h, icon } from '../dom.js';
import { capeFront, libraryUrl, skinFront, skinHead, skinModel, textureUrl } from '../skin-view.js';
import { state, update } from '../state.js';
import { dialog } from './modals.js';

/** Banderole : le refus de Mojang passe avant les informations. */
function banner(modal, account, seconds) {
  let kind = null;
  let title;
  let text;
  if (seconds > 0) {
    kind = 'warn';
    title = t('skins.mojang_limite_les_changements_de');
    text = t('skins.attends_un_peu_le_launcher');
  } else if (account?.needsLogin) {
    kind = 'warn';
    title = t('skins.session_microsoft_expiree');
    text = t('skins.reconnecte_ce_compte_depuis_la');
  } else if (modal.problem) {
    kind = 'warn';
    title = t('skins.mojang_pas_pris_le_changement');
    text = modal.problem.message;
  } else if (account?.type === 'offline') {
    kind = 'info';
    title = t('skins.pas_de_skin_personnalise_en');
    text = t('skins.sur_un_compte_hors_ligne');
  } else if (modal.done) {
    kind = 'ok';
    title = t('skins.applique_sur_ton_compte');
    text = t('skins.tu_le_verras_ta_prochaine');
  }
  if (!kind) return null;
  return h(
    'div',
    { class: `skins-banner skins-banner--${kind}`, role: kind === 'warn' ? 'alert' : 'status' },
    h('span', { class: 'skins-banner__title' }, title),
    h('span', { class: 'skins-banner__text' }, text),
  );
}

function modelPane(modal) {
  const current = currentSkin(modal);
  const pick = modal.pick;
  let stage;
  if (pick?.kind === 'library') {
    const skin = modal.data.library.find((s) => s.id === pick.id);
    stage = skin && { url: libraryUrl(skin.id), legacy: skin.legacy };
  } else if (pick?.kind === 'current' && current) stage = { url: textureUrl(current.hash), legacy: current.legacy };
  const capes = modal.data?.account?.look?.capes ?? [];
  const cape = capes.find((c) => c.id === modal.cape);
  return h(
    'div',
    { class: 'skins__stage' },
    stage
      ? skinModel({ ...stage, slim: modal.variant === 'slim', capeUrl: cape ? textureUrl(cape.hash) : null }, modal.view)
      : h('p', { class: 'skins__empty' }, modal.loading ? t('common.chargement') : t('skins.importe_un_skin_pour_le')),
    h(
      'div',
      { class: 'skins__stage-bar' },
      h('span', { class: 'hint', style: 'flex:1' }, t('skins.glisse_pour_tourner')),
      h('button', { class: 'btn', onClick: () => viewSide(modal, 'front') }, t('skins.face')),
      h('button', { class: 'btn', onClick: () => viewSide(modal, 'back') }, t('skins.dos')),
    ),
  );
}

function skinTile({ selected, name, tag, preview, onPick, onRemove }) {
  return h(
    'div',
    { class: `skin-tile${selected ? ' skin-tile--on' : ''}` },
    h(
      'button',
      { class: 'skin-tile__pick', 'aria-pressed': selected ? 'true' : 'false', onClick: onPick },
      preview,
      h('span', { class: 'skin-tile__name' }, name),
      h('span', { class: 'skin-tile__tag' }, tag ?? ''),
    ),
    onRemove && h('button', { class: 'skin-tile__remove', 'aria-label': t('skins.retirer_de_mes_skins', { name }), onClick: onRemove }, icon('close', 12)),
  );
}

function skinsSection(modal) {
  const current = currentSkin(modal);
  const tiles = [];
  if (current && !current.libraryId) {
    tiles.push(
      skinTile({
        selected: modal.pick?.kind === 'current',
        name: t('skins.sur_ce_compte'),
        tag: t('skins.actuel'),
        preview: skinFront(textureUrl(current.hash), { slim: current.variant === 'slim', legacy: current.legacy }),
        onPick: () => pickSkin(modal, { kind: 'current' }),
      }),
    );
  }
  for (const skin of modal.data?.library ?? []) {
    const isCurrent = current?.libraryId === skin.id;
    tiles.push(
      skinTile({
        selected: modal.pick?.kind === 'library' && modal.pick.id === skin.id,
        name: skin.name,
        tag: isCurrent ? t('skins.actuel') : null,
        preview: skinFront(libraryUrl(skin.id), { slim: skin.variant === 'slim', legacy: skin.legacy }),
        onPick: () => pickSkin(modal, { kind: 'library', id: skin.id }),
        onRemove: isCurrent ? null : () => removeLibrarySkin(modal, skin.id),
      }),
    );
  }
  tiles.push(
    h('button', { class: 'skin-tile skin-tile--add', onClick: () => importSkin(modal) }, icon('plus', 20), t('skins.importer_un_png')),
  );

  const input = h('input', {
    id: 'skins-copy',
    class: 'input input--pixel',
    type: 'text',
    maxlength: 16,
    placeholder: t('common.pseudo'),
    spellcheck: 'false',
    'data-keep': true,
    onKeydown: (e) => e.key === 'Enter' && copyPlayerSkin(modal, input),
  });
  const variant = modal.variant;
  return h(
    'section',
    { class: 'skins__section' },
    h('h2', { class: 'label' }, t('skins.mes_skins')),
    h('div', { class: 'skins__grid', 'data-scroll-key': 'skins-grid' }, tiles),
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'hint', for: 'skins-copy', style: 'font-weight:600' }, t('skins.copier_le_skin_public_un')),
      h(
        'div',
        { class: 'input-row' },
        input,
        h('button', { class: 'btn', disabled: Boolean(modal.copying), onClick: () => copyPlayerSkin(modal, input) }, modal.copying ? t('common.recherche') : t('skins.ajouter_mes_skins')),
      ),
    ),
    h(
      'div',
      { class: 'skins__model' },
      h('span', { class: 'hint', id: 'skins-variant', style: 'font-weight:600' }, t('skins.modele')),
      h(
        'div',
        { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'skins-variant' },
        h('button', { role: 'radio', 'aria-checked': variant === 'classic' ? 'true' : 'false', disabled: !modal.pick, onClick: () => setVariant(modal, 'classic') }, t('skins.classique_bras_de_px')),
        h('button', { role: 'radio', 'aria-checked': variant === 'slim' ? 'true' : 'false', disabled: !modal.pick, onClick: () => setVariant(modal, 'slim') }, t('skins.fin_bras_de_px')),
      ),
    ),
  );
}

function capesSection(modal, account) {
  const capes = account?.look?.capes ?? [];
  const tile = (id, name, preview) =>
    h(
      'button',
      { class: `cape-tile${modal.cape === id ? ' cape-tile--on' : ''}`, 'aria-pressed': modal.cape === id ? 'true' : 'false', onClick: () => pickCape(modal, id) },
      preview,
      h('span', { class: 'skin-tile__name' }, name),
    );
  let body;
  if (account?.type !== 'microsoft') {
    body = h('p', { class: 'hint' }, t('skins.les_capes_appartiennent_un_compte'));
  } else if (!capes.length) {
    body = h('p', { class: 'hint' }, t('skins.ce_compte_ne_possede_pas'));
  } else {
    body = h(
      'div',
      { class: 'skins__capes' },
      tile(null, t('skins.aucune'), h('span', { class: 'cape-tile__none' })),
      capes.map((c) => tile(c.id, c.alias, capeFront(textureUrl(c.hash)))),
    );
  }
  return h('section', { class: 'skins__section' }, h('h2', { class: 'label' }, t('skins.cape')), body);
}

export function skinsDialog(modal) {
  const account = modal.data?.account ?? state.accounts.find((a) => a.id === modal.accountId);
  if (!account) return null;
  const microsoft = account.type === 'microsoft';
  const seconds = Math.max(0, Math.ceil(((modal.data?.cooldownUntil ?? 0) - Date.now()) / 1000));
  if (seconds > 0) setTimeout(() => update(), 1000);
  const blocked = seconds > 0 || account.needsLogin || !microsoft;
  const change = modal.data ? pendingChange(modal) : null;
  const canApply = !blocked && !modal.busy && !modal.loading && Boolean(change);
  const canReset = !blocked && !modal.busy && !modal.loading && Boolean(currentSkin(modal));
  let label = t('skins.appliquer');
  if (!microsoft) label = t('skins.compte_microsoft_requis');
  else if (seconds > 0) label = t('skins.reessayer_dans', { seconds });
  else if (modal.busy) label = t('skins.envoi');

  const title = h(
    'span',
    { class: 'skins__title' },
    skinHead(account, 40),
    h(
      'span',
      { class: 'skins__title-text' },
      t('common.skin_et_cape'),
      h('span', { class: 'skins__account' }, `${account.name} · ${microsoft ? t('common.compte_microsoft') : t('common.hors_ligne')}`),
    ),
  );
  return dialog({
    title,
    size: 'dialog--skins',
    labelId: 'skins-title',
    body: h(
      'div',
      { class: 'skins' },
      modelPane(modal),
      h('div', { class: 'skins__side' }, banner(modal, account, seconds), skinsSection(modal), capesSection(modal, account)),
    ),
    foot: [
      h('span', { class: 'hint spacer' }, microsoft ? t('skins.le_fichier_part_chez_mojang') : t('skins.png_de_64_64_ou')),
      microsoft && h('button', { class: 'btn btn--lg', disabled: !canReset, onClick: () => resetSkin(modal) }, modal.confirmReset ? t('skins.confirmer') : t('skins.skin_par_defaut')),
      h('button', { class: 'btn btn--primary btn--lg', disabled: !canApply, onClick: () => applyChange(modal) }, label),
    ],
  });
}
