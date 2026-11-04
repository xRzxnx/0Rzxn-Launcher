// Onglet Captures : galerie par jour et visionneuse (fenêtre modale « screenshot »).
import { LOADER_NAMES, formatLastPlayed } from '../data.js';
import { blockIcon, formatSize, h, icon } from '../dom.js';
import { copyShot, deleteShot, instanceShots, openShot, openShotsFolder, openViewer, shotUrl, showShot, stepViewer } from '../screenshots-actions.js';
import { selectedInstance, state, update } from '../state.js';

const TIME = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

function dayLabel(timestamp) {
  const relative = formatLastPlayed(timestamp);
  if (relative === "aujourd'hui") return 'Aujourd’hui';
  if (relative === 'hier') return 'Hier';
  return DAY.format(new Date(timestamp)).replace(/^1 /, '1er ');
}

function byDay(items) {
  const days = [];
  for (const shot of items) {
    const label = dayLabel(shot.takenAt);
    if (days.at(-1)?.label !== label) days.push({ label, shots: [] });
    days.at(-1).shots.push(shot);
  }
  return days;
}

function thumb(instance, shot) {
  const time = TIME.format(new Date(shot.takenAt));
  return h(
    'figure',
    { class: 'shot' },
    h(
      'button',
      { class: 'shot__open', 'aria-label': `Ouvrir la capture de ${time}`, onClick: () => openViewer(instance, shot) },
      h('img', { src: shotUrl(instance.id, shot), alt: '', loading: 'lazy', decoding: 'async' }),
    ),
    h('button', { class: 'shot__copy', onClick: () => copyShot(instance.id, shot) }, icon('copy'), 'Copier'),
    h('figcaption', null, time),
  );
}

export function renderScreenshots() {
  const instance = selectedInstance();
  if (!instance) {
    return h('div', { class: 'empty' }, h('h1', { class: 'empty__title' }, 'Aucune instance'), h('p', { class: 'empty__text' }, 'Crée une instance : ses captures d’écran (F2 dans le jeu) apparaîtront ici.'));
  }
  const data = instanceShots(instance);
  const items = data?.items ?? [];
  const total = items.reduce((sum, s) => sum + s.size, 0);
  let message = null;
  if (!data || (data.loading && !data.items)) message = 'Lecture des captures…';
  else if (data.error) message = data.error;
  else if (!items.length) message = 'Aucune capture pour l’instant. Appuie sur F2 dans le jeu pour en prendre une.';

  return h(
    'div',
    { class: 'mods-page' },
    h(
      'div',
      { class: 'mods-main' },
      h(
        'div',
        { class: 'page__head' },
        h('h1', { class: 'page__title' }, 'Captures d’écran'),
        h('span', { class: 'mods-instance' }, blockIcon(instance.icon, 'block--sm'), `${instance.name} · ${instance.version}${instance.loader !== 'vanilla' ? ` · ${LOADER_NAMES[instance.loader]}` : ''}`),
        h('span', { class: 'page__spacer' }),
        h('button', { class: 'btn btn--lg', onClick: () => openShotsFolder(instance) }, icon('folder'), 'Ouvrir le dossier'),
      ),
      items.length > 0 && h('p', { class: 'page__meta', style: 'margin:10px 0 0' }, `${items.length} CAPTURE${items.length > 1 ? 'S' : ''} · ${formatSize(total).toUpperCase()} · F2 DANS LE JEU POUR EN PRENDRE UNE`),
      h(
        'div',
        { class: 'shots', 'data-scroll-key': 'screenshots' },
        message
          ? h('p', { class: 'vtable__empty' }, message)
          : byDay(items).map((day) => [
              h('h2', { class: 'shots__day label' }, `${day.label} · ${day.shots.length}`),
              h('div', { class: 'shots__grid' }, day.shots.map((shot) => thumb(instance, shot))),
            ]),
      ),
    ),
  );
}

/** Visionneuse plein écran (Échap ferme, ← → pour changer de capture). */
export function screenshotViewer(modal) {
  const items = state.screenshots.lists[modal.instanceId]?.items ?? [];
  const index = items.findIndex((s) => s.file === modal.file);
  const shot = items[index];
  const instance = state.instances.find((i) => i.id === modal.instanceId);
  if (!shot || !instance) return null;
  const close = () => update((s) => { s.modal = null; });
  const date = new Date(shot.takenAt);
  const relative = formatLastPlayed(shot.takenAt);
  const meta = [
    instance.name,
    `${relative === "aujourd'hui" || relative === 'hier' ? relative : `le ${DAY.format(date)}`} à ${TIME.format(date)}`,
    shot.width && `${shot.width} × ${shot.height}`,
    formatSize(shot.size),
  ].filter(Boolean);
  return h(
    'div',
    { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Capture ${shot.file}`, onClick: (e) => e.target === e.currentTarget && close() },
    h(
      'div',
      { class: 'viewer__bar' },
      h('div', { class: 'viewer__info' }, h('span', { class: 'viewer__name mono' }, shot.file), h('span', { class: 'viewer__meta' }, meta.join(' · '))),
      h('button', { class: 'btn btn--primary', onClick: () => copyShot(instance.id, shot) }, icon('copy'), 'Copier l’image'),
      h('button', { class: 'btn', onClick: () => openShot(instance.id, shot) }, 'Ouvrir'),
      h('button', { class: 'btn', onClick: () => showShot(instance.id, shot) }, 'Afficher dans le dossier'),
      h('button', { class: 'dialog__close viewer__trash', 'aria-label': 'Mettre la capture à la corbeille', onClick: () => deleteShot(instance, shot) }, icon('trash')),
      h('span', { class: 'viewer__sep', 'aria-hidden': 'true' }),
      h('button', { class: 'dialog__close', 'aria-label': 'Fermer', onClick: close }, icon('close')),
    ),
    h(
      'div',
      { class: 'viewer__stage', onClick: (e) => e.target === e.currentTarget && close() },
      h('button', { class: 'viewer__nav', 'aria-label': 'Capture précédente', disabled: index <= 0, onClick: () => stepViewer(-1) }, icon('back')),
      h('img', { class: 'viewer__image', src: shotUrl(instance.id, shot, 'full'), alt: `Capture du ${DAY.format(date)} à ${TIME.format(date)}` }),
      h('button', { class: 'viewer__nav', 'aria-label': 'Capture suivante', disabled: index >= items.length - 1, onClick: () => stepViewer(1) }, icon('next')),
    ),
    h('p', { class: 'viewer__foot' }, h('strong', null, `${index + 1} / ${items.length}`), '← → POUR CHANGER DE CAPTURE · ÉCHAP POUR FERMER'),
  );
}
