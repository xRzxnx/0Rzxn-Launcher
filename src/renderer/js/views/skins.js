// Fenêtre « Skin et cape » d'un compte : aperçu 3D, Mes skins, capes.
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
    title = 'Mojang limite les changements de skin';
    text = 'Attends un peu : le launcher ne réessaie jamais tout seul, pour ne pas mettre ton compte en danger.';
  } else if (account?.needsLogin) {
    kind = 'warn';
    title = 'Session Microsoft expirée';
    text = 'Reconnecte ce compte depuis la fenêtre Comptes pour changer de skin ou de cape.';
  } else if (modal.problem) {
    kind = 'warn';
    title = 'Mojang n’a pas pris le changement';
    text = modal.problem.message;
  } else if (account?.type === 'offline') {
    kind = 'info';
    title = 'Pas de skin personnalisé en jeu';
    text = 'Sur un compte hors-ligne, Minecraft affiche un skin par défaut sans mod. Tu peux quand même préparer tes skins ici : ils seront prêts quand ton compte Microsoft sera connecté.';
  } else if (modal.done) {
    kind = 'ok';
    title = 'Appliqué sur ton compte';
    text = 'Tu le verras à ta prochaine partie. Sur un serveur, à ta prochaine connexion.';
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
      : h('p', { class: 'skins__empty' }, modal.loading ? 'Chargement…' : 'Importe un skin pour le voir ici.'),
    h(
      'div',
      { class: 'skins__stage-bar' },
      h('span', { class: 'hint', style: 'flex:1' }, 'Glisse pour tourner'),
      h('button', { class: 'btn', onClick: () => viewSide(modal, 'front') }, 'Face'),
      h('button', { class: 'btn', onClick: () => viewSide(modal, 'back') }, 'Dos'),
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
    onRemove && h('button', { class: 'skin-tile__remove', 'aria-label': `Retirer ${name} de Mes skins`, onClick: onRemove }, icon('close', 12)),
  );
}

function skinsSection(modal) {
  const current = currentSkin(modal);
  const tiles = [];
  if (current && !current.libraryId) {
    tiles.push(
      skinTile({
        selected: modal.pick?.kind === 'current',
        name: 'Sur ce compte',
        tag: 'Actuel',
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
        tag: isCurrent ? 'Actuel' : null,
        preview: skinFront(libraryUrl(skin.id), { slim: skin.variant === 'slim', legacy: skin.legacy }),
        onPick: () => pickSkin(modal, { kind: 'library', id: skin.id }),
        onRemove: isCurrent ? null : () => removeLibrarySkin(modal, skin.id),
      }),
    );
  }
  tiles.push(
    h('button', { class: 'skin-tile skin-tile--add', onClick: () => importSkin(modal) }, icon('plus', 20), 'Importer un PNG'),
  );

  const input = h('input', {
    id: 'skins-copy',
    class: 'input input--pixel',
    type: 'text',
    maxlength: 16,
    placeholder: 'Pseudo',
    spellcheck: 'false',
    'data-keep': true,
    onKeydown: (e) => e.key === 'Enter' && copyPlayerSkin(modal, input),
  });
  const variant = modal.variant;
  return h(
    'section',
    { class: 'skins__section' },
    h('h2', { class: 'label' }, 'Mes skins'),
    h('div', { class: 'skins__grid', 'data-scroll-key': 'skins-grid' }, tiles),
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'hint', for: 'skins-copy', style: 'font-weight:600' }, "Copier le skin public d'un joueur"),
      h(
        'div',
        { class: 'input-row' },
        input,
        h('button', { class: 'btn', disabled: Boolean(modal.copying), onClick: () => copyPlayerSkin(modal, input) }, modal.copying ? 'Recherche…' : 'Ajouter à Mes skins'),
      ),
    ),
    h(
      'div',
      { class: 'skins__model' },
      h('span', { class: 'hint', id: 'skins-variant', style: 'font-weight:600' }, 'Modèle'),
      h(
        'div',
        { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'skins-variant' },
        h('button', { role: 'radio', 'aria-checked': variant === 'classic' ? 'true' : 'false', disabled: !modal.pick, onClick: () => setVariant(modal, 'classic') }, 'Classique · bras de 4 px'),
        h('button', { role: 'radio', 'aria-checked': variant === 'slim' ? 'true' : 'false', disabled: !modal.pick, onClick: () => setVariant(modal, 'slim') }, 'Fin · bras de 3 px'),
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
    body = h('p', { class: 'hint' }, "Les capes appartiennent à un compte Microsoft : elles s'affichent ici quand il est connecté.");
  } else if (!capes.length) {
    body = h('p', { class: 'hint' }, 'Ce compte ne possède pas de cape.');
  } else {
    body = h(
      'div',
      { class: 'skins__capes' },
      tile(null, 'Aucune', h('span', { class: 'cape-tile__none' })),
      capes.map((c) => tile(c.id, c.alias, capeFront(textureUrl(c.hash)))),
    );
  }
  return h('section', { class: 'skins__section' }, h('h2', { class: 'label' }, 'Cape'), body);
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
  let label = 'Appliquer';
  if (!microsoft) label = 'Compte Microsoft requis';
  else if (seconds > 0) label = `Réessayer dans ${seconds} s`;
  else if (modal.busy) label = 'Envoi…';

  const title = h(
    'span',
    { class: 'skins__title' },
    skinHead(account, 40),
    h(
      'span',
      { class: 'skins__title-text' },
      'Skin et cape',
      h('span', { class: 'skins__account' }, `${account.name} · ${microsoft ? 'Compte Microsoft' : 'Hors-ligne'}`),
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
      h('span', { class: 'hint spacer' }, microsoft ? 'Le fichier part chez Mojang seulement quand tu appuies sur Appliquer.' : 'PNG de 64×64 ou 64×32 pixels.'),
      microsoft && h('button', { class: 'btn btn--lg', disabled: !canReset, onClick: () => resetSkin(modal) }, modal.confirmReset ? 'Confirmer ?' : 'Skin par défaut'),
      h('button', { class: 'btn btn--primary btn--lg', disabled: !canApply, onClick: () => applyChange(modal) }, label),
    ],
  });
}
