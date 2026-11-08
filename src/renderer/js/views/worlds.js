// Onglet Mondes : mondes de l'instance (dossier saves), leurs sauvegardes .zip, restauration et suppression.
import { compareText, formatDateTime, t } from '../i18n.js';
import { LOADER_NAMES, formatLastPlayed } from '../data.js';
import { blockIcon, formatSize, h, icon } from '../dom.js';
import { selectedInstance, state, update } from '../state.js';
import { close, dialog } from './modals.js';
import {
  askDeleteWorld,
  askRestore,
  backupWorld,
  busyKey,
  cancelWorldTask,
  deleteBackup,
  deleteWorld,
  instanceWorlds,
  openWorldsFolder,
  playWorld,
  runRestore,
  selectWorld,
  setWorldsView,
} from '../worlds-actions.js';

const WHEN = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };

const MODES = () => ({
  survival: t('worlds.mode_survival'),
  creative: t('worlds.mode_creative'),
  adventure: t('worlds.mode_adventure'),
  spectator: t('worlds.mode_spectator'),
});
const REASONS = () => ({
  manual: t('worlds.raison_manual'),
  modpack: t('worlds.raison_modpack'),
  version: t('worlds.raison_version'),
  loader: t('worlds.raison_loader'),
  launch: t('worlds.raison_launch'),
});

const backupCount = (count) => (count ? t('worlds.n_sauvegardes', { count }) : t('worlds.pas_de_sauvegarde'));

const modeLabel = (world) => (world.hardcore ? t('worlds.hardcore') : (MODES()[world.mode] ?? null));

function worldIcon(world, size) {
  const style = `width:${size}px;height:${size}px`;
  if (world.icon) return h('img', { class: 'world-icon', src: world.icon, alt: '', style });
  return h('span', { class: 'world-icon world-icon--empty', style, 'aria-hidden': 'true' }, icon('worlds', Math.round(size / 2)));
}

function modeTag(world) {
  const label = modeLabel(world);
  return label && h('span', { class: `tag ${world.hardcore ? 'tag--bad' : ''}` }, label);
}

function sorted(list) {
  const by = {
    last: (a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0),
    name: (a, b) => compareText(a.name, b.name),
    size: (a, b) => (b.size ?? 0) - (a.size ?? 0),
  }[state.worlds.sort];
  const filter = state.worlds.filter.trim().toLowerCase();
  return list.filter((w) => !filter || `${w.name} ${w.folder}`.toLowerCase().includes(filter)).sort(by);
}

function progressLine(label) {
  const task = state.task;
  const percent = task?.total ? Math.round((task.done / task.total) * 100) : 0;
  return h(
    'div',
    { class: 'world-progress' },
    h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': label }, h('div', { class: 'progress__fill', style: `width:${percent}%` })),
    h('span', null, `${label} ${percent} %`),
    h('button', { class: 'btn btn--sm', onClick: cancelWorldTask }, t('common.annuler')),
  );
}

function worldRow(instance, world, current, backups) {
  const count = backups.filter((b) => b.folder === world.folder).length;
  const played = formatLastPlayed(world.lastPlayed);
  return h(
    'button',
    { class: 'world-row content-row content-row--hit', 'aria-selected': current ? 'true' : 'false', onClick: () => selectWorld(instance, world.folder) },
    worldIcon(world, 48),
    h(
      'span',
      { class: 'world-row__body' },
      h('span', { class: 'world-row__title' }, h('span', null, world.name), modeTag(world), world.newer && h('span', { class: 'tag tag--snapshot' }, t('worlds.version_plus_recente'))),
      h('span', { class: 'world-row__meta' }, [played && t('worlds.derniere_partie', { when: played }), world.version].filter(Boolean).join(' · ')),
    ),
    h(
      'span',
      { class: 'world-row__side' },
      h('span', null, world.size != null ? formatSize(world.size) : '…'),
      h('span', { class: 'world-row__meta' }, backupCount(count)),
    ),
  );
}

function backupRow(instance, world, backup, locked) {
  return h(
    'div',
    { class: 'backup-row' },
    h(
      'div',
      { class: 'backup-row__body' },
      h('b', null, formatDateTime(new Date(backup.createdAt), WHEN)),
      h('span', null, `${formatSize(backup.size)} · ${REASONS()[backup.reason] ?? REASONS().manual}`),
    ),
    h('span', { class: `tag ${backup.kind === 'auto' ? 'tag--release' : ''}` }, backup.kind === 'auto' ? t('worlds.auto') : t('worlds.manuelle')),
    h('button', { class: 'btn btn--sm', disabled: locked || Boolean(state.task), onClick: () => askRestore(instance, world, backup) }, t('worlds.restaurer')),
    h('button', { class: 'dialog__close', 'aria-label': t('worlds.supprimer_sauvegarde'), disabled: Boolean(state.task), onClick: () => deleteBackup(instance, backup) }, icon('trash')),
  );
}

function detailPanel(instance, world, backups, locked) {
  const mine = backups.filter((b) => b.folder === world.folder);
  const busy = state.worlds.busy[busyKey(instance, world.folder)];
  const otherTask = Boolean(state.task) && !busy;
  const played = world.lastPlayed ? formatDateTime(new Date(world.lastPlayed), WHEN) : '—';
  const fact = (label, value) => h('div', { class: 'world-fact' }, h('span', null, label), h('b', null, value));
  return h(
    'aside',
    { class: 'world-detail', 'aria-label': world.name },
    h('div', { class: 'world-detail__head' }, worldIcon(world, 64), h('div', null, h('h2', null, world.name), modeTag(world))),
    h(
      'div',
      { class: 'world-facts' },
      fact(t('worlds.derniere_partie_label'), played),
      fact(t('worlds.enregistre_avec'), world.version ? `Minecraft ${world.version}` : '—'),
      fact(t('worlds.taille'), world.size != null ? formatSize(world.size) : '…'),
      fact(t('worlds.dossier'), `saves\\${world.folder}`),
    ),
    world.newer && h('p', { class: 'notice notice--warn' }, icon('alert'), t('worlds.version_plus_recente_detail', { world: world.version, instance: instance.version })),
    locked && h('p', { class: 'notice' }, icon('lock'), t('worlds.jeu_ouvert')),
    busy
      ? progressLine(busy === 'restore' ? t('worlds.restauration') : t('worlds.sauvegarde'))
      : h(
          'div',
          { class: 'world-actions' },
          h('button', { class: 'btn btn--primary', disabled: Boolean(state.run) || !instance.quickPlay, title: instance.quickPlay ? null : t('worlds.quick_play_indisponible'), onClick: () => playWorld(instance, world) }, icon('play'), t('worlds.jouer_dans_ce_monde')),
          h('button', { class: 'btn', disabled: locked || otherTask, onClick: () => backupWorld(instance, world) }, icon('archive'), t('worlds.sauvegarder')),
          h('button', { class: 'btn', onClick: () => openWorldsFolder(instance, world.folder) }, icon('folder'), t('worlds.ouvrir_le_dossier')),
          h('button', { class: 'btn btn--danger', disabled: locked || otherTask, onClick: () => askDeleteWorld(instance, world) }, icon('trash'), t('worlds.supprimer')),
        ),
    h('div', { class: 'world-detail__label' }, h('span', null, t('worlds.sauvegardes')), h('span', null, backupCount(mine.length))),
    h(
      'div',
      { class: 'backup-list', 'data-scroll-key': `backups-${instance.id}` },
      mine.length ? mine.map((b) => backupRow(instance, world, b, locked)) : h('p', { class: 'hint', style: 'margin:0' }, t('worlds.aucune_sauvegarde')),
    ),
  );
}

export function renderWorlds() {
  const instance = selectedInstance();
  if (!instance) {
    return h('div', { class: 'empty' }, h('p', { class: 'empty__text' }, t('worlds.aucune_instance')));
  }
  const locked = state.run?.instanceId === instance.id;
  const data = instanceWorlds(instance);
  const all = data?.worlds ?? [];
  const list = sorted(all);
  const backups = data?.backups ?? [];
  const total = all.reduce((sum, w) => sum + (w.size ?? 0), 0);
  const chosen = all.find((w) => w.folder === state.worlds.selected[instance.id]) ?? list[0] ?? all[0];

  let message = null;
  if (!data || (data.loading && !data.worlds)) message = t('worlds.lecture');
  else if (data.error) message = data.error;
  else if (!all.length) message = t('worlds.aucun_monde');
  else if (!list.length) message = t('mods.aucun_resultat_pour_ce_filtre');

  const sorts = [['last', t('worlds.tri_derniere_partie')], ['name', t('worlds.tri_nom')], ['size', t('worlds.taille')]];
  return h(
    'div',
    { class: 'mods-page' },
    h(
      'div',
      { class: 'mods-main' },
      h(
        'div',
        { class: 'page__head' },
        h('h1', { class: 'page__title' }, t('chrome.mondes')),
        h('span', { class: 'mods-instance' }, blockIcon(instance.icon, 'block--sm'), `${instance.name} · ${instance.version}${instance.loader !== 'vanilla' ? ` · ${LOADER_NAMES[instance.loader]}` : ''}`),
        all.length > 0 && h('span', { class: 'world-total' }, `${t('worlds.n_mondes', { count: all.length })} · ${formatSize(total)}`),
        h('span', { class: 'page__spacer' }),
        h('button', { class: 'btn btn--lg', onClick: () => openWorldsFolder(instance) }, icon('folder'), t('worlds.dossier_saves')),
      ),
      h(
        'div',
        { class: 'toolbar' },
        h(
          'label',
          { class: 'search' },
          icon('search'),
          h('span', { class: 'visually-hidden' }, t('worlds.chercher')),
          h('input', { id: 'worlds-filter', type: 'search', placeholder: t('worlds.chercher'), value: state.worlds.filter, onInput: (e) => setWorldsView({ filter: e.target.value }) }),
        ),
        h(
          'div',
          { class: 'segmented', role: 'radiogroup', 'aria-label': t('worlds.trier') },
          sorts.map(([id, label]) => h('button', { role: 'radio', 'aria-checked': state.worlds.sort === id ? 'true' : 'false', onClick: () => setWorldsView({ sort: id }) }, label)),
        ),
      ),
      h(
        'div',
        { class: 'worlds-layout' },
        h('div', { class: 'content-list', 'data-scroll-key': `worlds-${instance.id}` }, message ? h('p', { class: 'vtable__empty' }, message) : list.map((w) => worldRow(instance, w, w === chosen, backups))),
        chosen && detailPanel(instance, chosen, backups, locked),
      ),
    ),
  );
}

// ---------- Fenêtres ----------

function restoreDialog(modal) {
  const option = (mode, title, detail) =>
    h(
      'button',
      { class: 'option', role: 'radio', 'aria-checked': modal.mode === mode ? 'true' : 'false', onClick: () => update((s) => { s.modal.mode = mode; }) },
      h('span', { class: 'option__dot' }),
      h('span', { class: 'option__body' }, h('span', { class: 'option__title' }, title), h('span', { class: 'option__detail' }, detail)),
    );
  return dialog({
    title: t('worlds.restaurer_titre', { name: modal.name }),
    size: 'dialog--small',
    labelId: 'restore-title',
    body: [
      h('p', { style: 'margin:0' }, t('worlds.sauvegarde_du', { date: formatDateTime(new Date(modal.backup.createdAt), WHEN), size: formatSize(modal.backup.size) })),
      h(
        'div',
        { role: 'radiogroup', 'aria-label': t('worlds.restaurer'), style: 'display:flex;flex-direction:column;gap:8px' },
        option('beside', t('worlds.a_cote'), t('worlds.a_cote_detail', { name: modal.name })),
        option('replace', t('worlds.remplacer'), t('worlds.remplacer_detail')),
      ),
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: close }, t('common.annuler')),
      h('button', { class: 'btn btn--lg btn--primary', onClick: () => runRestore(modal) }, icon('restore'), t('worlds.restaurer')),
    ],
  });
}

function deleteWorldDialog(modal) {
  return dialog({
    title: t('worlds.supprimer_titre', { name: modal.name }),
    size: 'dialog--small',
    labelId: 'delete-world-title',
    body: [h('p', { style: 'margin:0' }, t('worlds.supprimer_detail'))],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: close }, t('common.annuler')),
      h('button', { class: 'btn btn--lg btn--danger', onClick: () => deleteWorld(modal) }, icon('trash'), t('worlds.supprimer')),
    ],
  });
}

/** Fenêtres de l'onglet Mondes (appelé par renderModal). */
export function worldsDialog(modal) {
  if (modal.type === 'restore-world') return restoreDialog(modal);
  if (modal.type === 'delete-world') return deleteWorldDialog(modal);
  return null;
}
