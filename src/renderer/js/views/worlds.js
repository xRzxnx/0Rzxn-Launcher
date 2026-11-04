// Onglet Mondes : mondes de l'instance (dossier saves) et sauvegardes .zip.
import { openImport } from '../import-actions.js';
import { LOADER_NAMES, formatLastPlayed } from '../data.js';
import { blockIcon, formatSize, h, icon } from '../dom.js';
import { selectedInstance, state } from '../state.js';
import {
  askDeleteWorld,
  backupWorld,
  busyKey,
  cancelTask,
  deleteBackup,
  instanceWorlds,
  openBackups,
  openWorldsFolder,
  pickAndRestore,
  restoreFrom,
} from '../worlds-actions.js';

const GAME_TYPES = ['Survie', 'Créatif', 'Aventure', 'Spectateur'];
const TIME = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' });

/** « aujourd'hui à 18:42 », « hier à 22:10 », « 28 octobre ». */
function when(timestamp) {
  if (!timestamp) return null;
  const relative = formatLastPlayed(timestamp);
  if (relative === "aujourd'hui" || relative === 'hier') return `${relative} à ${TIME.format(new Date(timestamp))}`;
  return DAY.format(new Date(timestamp));
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function worldMeta(world) {
  const mode = world.hardcore ? null : GAME_TYPES[world.gameType] ?? null;
  const played = when(world.lastPlayed);
  return [mode, world.version && `Minecraft ${world.version}`, played && `dernière partie ${played}`, world.size != null && formatSize(world.size)].filter(Boolean).join(' · ');
}

function worldRow(instance, world, locked) {
  const busy = state.worlds.busy[busyKey(instance, world.folder)] === 'backup';
  const task = busy ? state.task : null;
  const percent = task?.total ? Math.round((task.done / task.total) * 100) : 0;
  const otherTask = Boolean(state.task) && !busy;
  return h(
    'section',
    { class: 'world-row', 'aria-label': world.name },
    world.icon
      ? h('img', { class: 'world-icon', src: world.icon, alt: '' })
      : h('span', { class: 'world-icon world-icon--empty', 'aria-hidden': 'true' }, icon('worlds')),
    h(
      'div',
      { class: 'world-row__body' },
      h(
        'div',
        { class: 'world-row__title' },
        h('h3', null, world.name),
        world.hardcore && h('span', { class: 'tag tag--bad' }, 'HARDCORE'),
      ),
      h('p', { class: 'world-row__meta' }, worldMeta(world)),
      busy
        ? h(
            'div',
            { class: 'world-row__progress' },
            h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Sauvegarde' }, h('div', { class: 'progress__fill', style: `width:${percent}%` })),
            h('span', null, task?.total ? `Sauvegarde… ${percent} % · ${task.done.toLocaleString('fr-FR')} / ${task.total.toLocaleString('fr-FR')} fichiers` : 'Sauvegarde…'),
          )
        : h('p', { class: 'world-row__folder mono' }, `saves\\${world.folder}`),
    ),
    busy
      ? h('button', { class: 'btn btn--ghost', onClick: cancelTask }, 'Annuler')
      : h('button', { class: 'btn', disabled: otherTask, title: otherTask ? `Patiente : ${state.task.label}` : null, onClick: () => backupWorld(instance, world) }, icon('archive'), 'Sauvegarder'),
    h('button', { class: 'dialog__close', 'aria-label': `Ouvrir le dossier de ${world.name}`, onClick: () => openWorldsFolder(instance, world.folder) }, icon('folder')),
    h(
      'button',
      {
        class: 'dialog__close',
        'aria-label': `Mettre ${world.name} à la corbeille`,
        disabled: locked || busy,
        title: locked ? 'Ferme le jeu avant de supprimer un monde' : null,
        onClick: () => askDeleteWorld(instance, world),
      },
      icon('trash'),
    ),
  );
}

function backupsPanel(instance, backups, locked) {
  const total = backups.reduce((sum, b) => sum + b.size, 0);
  return h(
    'aside',
    { class: 'backups', 'aria-label': 'Sauvegardes' },
    h(
      'div',
      { class: 'backups__head' },
      h('h2', { class: 'label', style: 'margin:0' }, 'Sauvegardes'),
      backups.length > 0 && h('span', { class: 'backups__count' }, `${backups.length} · ${formatSize(total)}`),
    ),
    backups.length === 0
      ? h('p', { class: 'backups__empty' }, 'Aucune sauvegarde pour l’instant. « Sauvegarder » crée un .zip du monde, que tu peux restaurer à tout moment.')
      : backups.map((backup) =>
          h(
            'div',
            { class: 'backup' },
            h(
              'div',
              { class: 'backup__body' },
              h('span', { class: 'backup__name' }, backup.name),
              h('span', { class: 'backup__meta' }, `${capitalize(when(backup.createdAt))} · ${formatSize(backup.size)}`),
            ),
            h(
              'button',
              { class: 'btn btn--sm', disabled: locked || Boolean(state.task), title: locked ? 'Ferme le jeu avant de restaurer' : null, onClick: () => restoreFrom(instance, { backup: backup.file }) },
              'Restaurer',
            ),
            h('button', { class: 'icon-btn', 'aria-label': `Mettre la sauvegarde ${backup.file} à la corbeille`, onClick: () => deleteBackup(instance, backup) }, icon('trash')),
          ),
        ),
    h('p', { class: 'backups__hint' }, 'Restaurer n’écrase rien : si le monde existe encore, tu choisis « à côté » ou « remplacer » (l’actuel part à la corbeille).'),
    h('button', { class: 'btn btn--ghost backups__link', onClick: () => openBackups(instance) }, icon('folder'), 'Dossier des sauvegardes'),
  );
}

export function renderWorlds() {
  const instance = selectedInstance();
  if (!instance) {
    return h('div', { class: 'empty' }, h('h1', { class: 'empty__title' }, 'Aucune instance'), h('p', { class: 'empty__text' }, 'Crée une instance pour y jouer et retrouver ses mondes ici.'));
  }
  const locked = state.run?.instanceId === instance.id;
  const data = instanceWorlds(instance);
  const list = data?.worlds ?? [];
  const total = list.reduce((sum, w) => sum + (w.size ?? 0), 0);

  let message = null;
  if (!data || (data.loading && !data.worlds)) message = 'Lecture des mondes…';
  else if (data.error) message = data.error;
  else if (!list.length) message = 'Aucun monde dans cette instance. Crée-en un dans le jeu, ou importe ceux de ton .minecraft.';

  return h(
    'div',
    { class: 'mods-page' },
    h(
      'div',
      { class: 'mods-main' },
      h(
        'div',
        { class: 'page__head' },
        h('h1', { class: 'page__title' }, 'Mondes'),
        h('span', { class: 'mods-instance' }, blockIcon(instance.icon, 'block--sm'), `${instance.name} · ${instance.version}${instance.loader !== 'vanilla' ? ` · ${LOADER_NAMES[instance.loader]}` : ''}`),
        h('span', { class: 'page__spacer' }),
        h('button', { class: 'square-btn', style: 'width:40px;height:40px', 'aria-label': 'Ouvrir le dossier saves', title: 'Ouvrir le dossier saves', onClick: () => openWorldsFolder(instance) }, icon('folder')),
        h('button', { class: 'btn', onClick: () => openImport('worlds') }, 'Importer des mondes…'),
        h('button', { class: 'btn', disabled: locked || Boolean(state.task), title: locked ? 'Ferme le jeu avant de restaurer' : null, onClick: () => pickAndRestore(instance) }, icon('restore'), 'Restaurer un .zip…'),
      ),
      list.length > 0 && h('p', { class: 'page__meta', style: 'margin:10px 0 0' }, `${list.length} MONDE${list.length > 1 ? 'S' : ''} · ${formatSize(total).toUpperCase()} · TRIÉS PAR DERNIÈRE PARTIE`),
      locked && h('p', { class: 'offline-banner', style: 'margin:14px 0 0' }, icon('lock'), h('span', null, 'Le jeu est lancé : tu peux sauvegarder, mais restaurer et supprimer attendent que le jeu soit fermé. Quitte le monde avant pour une sauvegarde à jour.')),
      h(
        'div',
        { class: 'worlds-layout' },
        h(
          'div',
          { class: 'content-list', 'data-scroll-key': 'worlds' },
          message ? h('p', { class: 'vtable__empty' }, message) : list.map((world) => worldRow(instance, world, locked)),
        ),
        backupsPanel(instance, data?.backups ?? [], locked),
      ),
    ),
  );
}
