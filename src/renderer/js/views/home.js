// Onglet Accueil : bannière de l'instance, bouton Jouer, cartes d'informations ou progression.
import { createShortcut, duplicateInstance, openInstanceFolder, requestLaunch, saveSettings, stopGame, verifyInstance, versionDetails } from '../actions.js';
import { checkModpackUpdate, installedContent, pendingModUpdates, updateItems, updateModpack } from '../mods-actions.js';
import { openRecap } from '../recap-actions.js';
import { ramGuide,refreshFreeRam } from '../perf-actions.js';
import { FILES_STEP, JAVA_STEP, LAUNCH_STEPS, LOADER_NAMES, LOADER_STEP, MEMORY_STEP, formatLastPlayed, loaderLabel, ramRange, ramVerdict, ramZones } from '../data.js';
import { formatGo, formatPlaytime, h, icon } from '../dom.js';
import { skinHead } from '../skin-view.js';
import { activeAccount, instanceAccount, instanceStatus, runPercent, selectedInstance, state, update } from '../state.js';
import { go, openNewInstance } from './chrome.js';

const javaLabel = (details) => (details ? `Java ${details.java}` : 'Java');

function playButton(instance, status) {
  if (!activeAccount()) return h('button', { class: 'play play--disabled', disabled: true }, 'Aucun compte');
  if (status.kind === 'running') {
    return h('button', { class: 'play play--running', onClick: stopGame }, h('span', { class: 'dot', 'aria-hidden': 'true' }), 'En jeu · Arrêter');
  }
  if (status.kind === 'busy') return h('button', { class: 'play play--busy', onClick: stopGame, title: 'Annuler' }, status.label);
  if (state.run) return h('button', { class: 'play play--disabled', disabled: true }, 'Une autre partie tourne');
  if (!instance.installed) {
    return h('button', { class: 'play play--install', onClick: () => requestLaunch() }, icon('download'), `Installer ${instance.version}`);
  }
  return h('button', { class: 'play', onClick: () => requestLaunch() }, icon('play'), 'Jouer');
}

/** Rappel à côté de Jouer quand l'instance a son propre compte. */
function fixedAccount(instance) {
  const account = instanceAccount(instance);
  if (!account) return null;
  return h('span', { class: 'hero__account' }, skinHead(account, 28), h('span', null, `Toujours avec ${account.name}`));
}

const UPDATE_ROWS = 3;

/** Carte en haut à droite : mods à mettre à jour, sans ouvrir l'onglet Mods. */
function updatesCard(instance) {
  const items = pendingModUpdates(instance);
  if (!items.length) return null;
  const shown = items.slice(0, UPDATE_ROWS);
  const more = items.length - shown.length;
  const busy = state.mods.busy['*update-all*'];
  return h(
    'section',
    { class: 'upcard', 'aria-label': 'Mises à jour de mods' },
    h('h3', { class: 'upcard__title' }, `${items.length} mise${items.length > 1 ? 's' : ''} à jour`),
    shown.map((item) =>
      h('div', { class: 'kv' }, h('span', { class: 'kv__name' }, item.title ?? item.name), h('b', { class: 'kv__ver' }, `${item.version ?? '?'} → ${item.update.number}`)),
    ),
    more > 0 && h('p', { class: 'upcard__more' }, `et ${more} autre${more > 1 ? 's' : ''}`),
    h('button', { class: 'btn btn--primary', disabled: busy, onClick: () => updateItems(instance, null, 'mods') }, icon('download'), busy ? 'Mise à jour…' : 'Tout mettre à jour'),
  );
}

function hero(instance, status, details, card) {
  const pillState = { ready: 'Prête', busy: status.label.split(' ·')[0], running: 'En jeu', idle: 'À installer' }[status.kind];
  const lastPlayed = formatLastPlayed(instance.lastPlayedAt);
  const sub =
    status.kind === 'busy' && !instance.installed
      ? 'Première installation : quelques centaines de Mo, partagés ensuite entre tes instances.'
      : `${loaderLabel(instance)} · ${javaLabel(details)} · ${formatPlaytime(instance.playtime)}${instance.playtime ? ' de jeu' : ''}`;

  return h(
    'section',
    { class: `hero${card ? ' hero--updates' : ''}`, 'aria-label': `Instance ${instance.name}` },
    card,
    h(
      'div',
      { class: 'hero__info' },
      h(
        'div',
        { class: 'hero__meta' },
        h('span', { class: 'status-pill' }, `Minecraft ${instance.version}${instance.loader !== 'vanilla' ? ` · ${LOADER_NAMES[instance.loader]}` : ''}`),
        h(
          'span',
          { class: `status-pill status-pill--${status.kind}` },
          h('span', { class: 'status-pill__dot', 'aria-hidden': 'true' }),
          h('span', { class: 'status-pill__state' }, pillState),
        ),
        lastPlayed && h('span', { class: 'status-pill' }, `Dernière partie ${lastPlayed}`),
      ),
      h('h1', { class: 'hero__title' }, instance.name),
      h('p', { class: 'hero__sub' }, sub),
    ),
    h(
      'div',
      { class: 'hero__bar' },
      playButton(instance, status),
      h(
        'div',
        { class: 'version-box' },
        h('span', { class: 'version-box__body' }, h('span', { class: 'label' }, 'Version'), h('span', { class: 'version-box__value' }, instance.version)),
      ),
      fixedAccount(instance),
      h('button', { class: 'btn btn--ghost', onClick: () => openInstanceFolder(instance.id) }, icon('folder'), 'Ouvrir le dossier'),
    ),
  );
}

/** Instance issue d'un modpack : version installée et mise à jour. */
function modpackCard(instance, busy) {
  const pack = instance.modpack;
  const check = state.modpackUpdates[instance.id];
  let action;
  if (!pack.projectId) action = h('span', { class: 'hint' }, 'Importé depuis un fichier');
  else if (check?.versionId) {
    action = h('button', { class: 'btn btn--primary', disabled: busy || Boolean(state.task), onClick: () => updateModpack(instance, check.versionId) }, icon('download'), `Mettre à jour vers ${check.number}`);
  } else {
    action = h('button', { class: 'btn btn--ghost', disabled: check?.checking, onClick: () => checkModpackUpdate(instance) }, check?.checking ? 'Vérification…' : check?.none ? 'Vérifier à nouveau' : 'Vérifier les mises à jour');
  }
  return h(
    'section',
    { class: 'card card__row' },
    pack.icon ? h('img', { class: 'content-icon', src: pack.icon, alt: '', style: 'width:44px;height:44px' }) : null,
    h(
      'div',
      { class: 'card__body' },
      h('h3', { class: 'card__title' }, `Modpack ${pack.name}`),
      h('p', { class: 'card__text' }, `Version ${pack.version} · ${pack.files?.length ?? 0} fichiers gérés par le modpack${check?.none ? ' · à jour' : ''}`),
    ),
    action,
  );
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const shortTime = (minutes) => (minutes ? formatPlaytime(Math.round(minutes)).replace(' min', '').replace(/^(\d+)$/, '$1 min') : '0 min');
const SINCE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });

function statTile(label, value, foot, extra) {
  return h('div', { class: 'stat-tile' }, h('span', { class: 'stat-tile__label' }, label), h('span', { class: 'stat-tile__value' }, value), foot, extra);
}

/** Temps de jeu : quatre tuiles compactes (total, semaine, parties, record). */
function statsTiles(instance) {
  const stats = instance.stats ?? { days: {}, sessions: 0, longest: 0 };
  const today = new Date();
  const week = Array.from({ length: 7 }, (_, i) => stats.days[dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (6 - i)))] ?? 0);
  const weekTotal = week.reduce((a, b) => a + b, 0);
  const peak = Math.max(30, ...week);
  const tracked = Object.values(stats.days).reduce((a, b) => a + b, 0);
  const untracked = Math.max(0, Math.round(instance.playtime - tracked));
  const total = state.instances.reduce((sum, i) => sum + (i.playtime ?? 0), 0);
  const share = total ? Math.round((instance.playtime / total) * 100) : 0;
  const alone = state.instances.filter((i) => i.playtime > 0).length < 2;
  const note = (text) => h('span', { class: 'stat-tile__foot' }, text);

  return h(
    'section',
    { class: 'stat-tiles', 'aria-label': 'Temps de jeu' },
    h(
      'div',
      { class: 'stat-tile', title: untracked > 0 ? `Dont ${formatPlaytime(untracked)} ${instance.importedFrom ? 'reprises d’un autre launcher ou ' : ''}d’avant le suivi par jour` : null },
      h('span', { class: 'stat-tile__label' }, 'Temps de jeu au total'),
      h('button', { class: 'stat-tile__link', title: 'Voir le bilan du mois', onClick: openRecap }, 'Bilan du mois'),
      h('span', { class: 'stat-tile__row' }, h('span', { class: 'stat-tile__value' }, shortTime(instance.playtime)), !alone && h('span', { class: 'stat-tile__share' }, `${share} %`)),
      alone
        ? note('Sur cette instance')
        : h('span', { class: 'stat-tile__meter', role: 'img', 'aria-label': `${share} % de ton temps total` }, h('i', { style: `width:${share}%` })),
    ),
    statTile(
      '7 derniers jours',
      shortTime(weekTotal),
      note('Par jour'),
      h(
        'span',
        { class: 'stat-tile__bars', 'aria-hidden': 'true' },
        week.map((minutes, i) => h('span', { class: `stat-tile__bar${minutes ? '' : ' stat-tile__bar--empty'}${i === 6 ? ' stat-tile__bar--today' : ''}`, style: `height:${Math.max(8, Math.round((minutes / peak) * 100))}%` })),
      ),
    ),
    statTile(stats.sessions > 1 ? 'Parties' : 'Partie', String(stats.sessions), note(stats.since ? `depuis le ${SINCE.format(new Date(stats.since))}` : stats.sessions ? 'Au total' : 'Aucune suivie')),
    statTile('Plus longue partie', shortTime(stats.longest), note(stats.sessions ? `moyenne ${shortTime(tracked / stats.sessions)}` : 'Pas encore de moyenne')),
  );
}

const CUBE_FACES = ['front', 'back', 'left', 'right', 'top', 'bottom'];
const SPIN_MS = 950;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Gardée entre deux rendus, pour que le bloc ne saute pas quand l'accueil se redessine.
const pose = { x: 0, y: 0, turns: 0 };

/** Bloc de l'instance en 3D : suit la souris, tourne au clic. Hors du verre flou, seul le cube bouge. */
function blockCube(instance, still) {
  const cube = h('span', { class: `cube cube--${instance.icon}` }, CUBE_FACES.map((face) => h('i', { class: `cube__face cube__face--${face}` })));
  const paint = () => {
    cube.style.transform = `rotateX(${-24 - pose.y * 14}deg) rotateY(${-38 + pose.x * 22 + pose.turns * 360}deg)`;
  };
  paint();
  let frame = 0;
  const aim = (x, y) => {
    pose.x = x;
    pose.y = y;
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  };
  const stage = h(
    'button',
    {
      class: `cube-stage loader--${instance.loader ?? 'vanilla'}`,
      'aria-label': 'Faire tourner le bloc',
      onClick: () => {
        if (reducedMotion()) return;
        pose.turns += 1;
        cube.classList.add('cube--spin');
        paint();
        setTimeout(() => cube.classList.remove('cube--spin'), SPIN_MS);
      },
    },
    h('span', { class: 'cube-stage__halo', 'aria-hidden': 'true' }),
    h('span', { class: `cube-stage__float${still ? ' cube-stage__float--still' : ''}` }, cube),
  );
  return { stage, aim };
}

const RAM_MIN = 1;

/** Tuile Mémoire : le conseil suit le curseur, d'après l'instance et les composants du PC. */
function ramTile(instance, guide, busy) {
  const settings = instance.settings;
  const max = Math.max(2, settings.ram, Math.floor(state.memory.totalGb * 2) / 2);
  const value = h('span', { class: 'spec-tile__value' }, formatGo(settings.ram));
  const badge = h('span', { class: 'ram-badge' });
  const advice = h('p', { class: 'ram-advice' });
  const showVerdict = () => {
    if (!guide) return;
    const verdict = ramVerdict(settings.ram, guide, state.memory.freeGb);
    badge.className = `ram-badge ram-badge--${verdict.level}`;
    badge.textContent = verdict.title;
    advice.textContent = verdict.text;
  };
  showVerdict();
  return h(
    'div',
    { class: 'spec-tile spec-tile--ram' },
    h('div', { class: 'ram-row' }, h('label', { class: 'spec-tile__label', for: 'home-ram' }, 'Mémoire'), badge),
    h(
      'div',
      { class: 'ram-row' },
      value,
      guide &&
        h(
          'button',
          {
            class: 'ram-ideal',
            disabled: busy,
            title: `Régler sur ${formatGo(guide.ideal)}`,
            onClick: () => update(() => {
              settings.ram = guide.ideal;
              saveSettings('instance', instance.id);
            }),
          },
          `Conseillé : ${ramRange(guide)}`,
        ),
    ),
    h('input', {
      id: 'home-ram',
      class: 'range-zones',
      type: 'range',
      min: RAM_MIN,
      max,
      step: 0.5,
      value: settings.ram,
      disabled: busy,
      style: guide ? `background:${ramZones(guide, RAM_MIN, max)}` : null,
      onPointerdown: refreshFreeRam,
      // Sans redessin, pour garder le curseur en main ; enregistré au relâchement.
      onInput: (e) => {
        settings.ram = Number(e.target.value);
        value.textContent = formatGo(settings.ram);
        showVerdict();
      },
      onChange: () => saveSettings('instance', instance.id),
    }),
    advice,
    guide && h('p', { class: 'ram-pc', title: guide.pc.detail }, guide.pc.summary),
  );
}

function modsValue(guide) {
  if (!guide) return '…';
  if (!guide.mods) return 'Aucun';
  return `${guide.mods} actif${guide.mods > 1 ? 's' : ''}`;
}

function blockAction(iconName, label, props) {
  return h('button', { class: 'block-action', ...props }, icon(iconName), label);
}

/** Bloc Instance : le cube, les quatre infos clés et les actions. */
function instanceBlock(instance, status, details) {
  const busy = state.run?.instanceId === instance.id;
  const { stage, aim } = blockCube(instance, status.kind === 'running');
  const follow = !reducedMotion();
  const custom = instance.settings.java === 'custom' && instance.settings.javaPath;
  const guide = ramGuide(instance);
  return h(
    'section',
    {
      class: 'instance-block',
      'aria-label': 'Instance',
      onPointermove: follow
        ? (e) => {
            const box = e.currentTarget.getBoundingClientRect();
            aim(((e.clientX - box.left) / box.width) * 2 - 1, ((e.clientY - box.top) / box.height) * 2 - 1);
          }
        : null,
      onPointerleave: follow ? () => aim(0, 0) : null,
    },
    stage,
    h(
      'div',
      { class: 'instance-block__specs' },
      h('button', { class: 'spec-tile', onClick: () => go('mods') }, h('span', { class: 'spec-tile__label' }, 'Mods'), h('span', { class: 'spec-tile__value' }, modsValue(guide))),
      ramTile(instance, guide, busy),
      h('button', { class: 'spec-tile', onClick: () => go('settings') }, h('span', { class: 'spec-tile__label' }, 'Java'), h('span', { class: 'spec-tile__value' }, custom ? 'Personnalisé' : javaLabel(details))),
    ),
    h(
      'div',
      { class: 'instance-block__actions' },
      blockAction('edit', 'Modifier', {
        disabled: busy,
        onClick: () => update((s) => { s.modal = { type: 'edit-instance', instanceId: instance.id, draft: { name: instance.name, icon: instance.icon, version: instance.version, loader: instance.loader, loaderVersion: instance.loaderVersion, group: instance.group ?? '', accountId: instance.accountId ?? null } }; }),
      }),
      blockAction('copy', 'Dupliquer', { disabled: busy, onClick: () => duplicateInstance(instance.id) }),
      blockAction('upload', 'Exporter', {
        onClick: () => update((s) => { s.modal = { type: 'export', instanceId: instance.id, draft: { name: instance.modpack?.name ?? instance.name, version: '1.0.0', summary: '' } }; }),
      }),
      blockAction('link', 'Raccourci', { onClick: () => createShortcut(instance.id) }),
      blockAction('shield', 'Vérifier', { disabled: !instance.installed || Boolean(state.run), onClick: () => verifyInstance(instance.id) }),
      blockAction('trash', 'Supprimer', {
        class: 'block-action block-action--danger',
        disabled: busy,
        onClick: () => update((s) => { s.modal = { type: 'delete-instance', instanceId: instance.id }; }),
      }),
    ),
  );
}

function infoCards(instance, status, details) {
  const busy = state.run?.instanceId === instance.id;
  return [
    state.versions.offline &&
      h(
        'p',
        { class: 'offline-banner', role: 'status' },
        icon('offline'),
        h(
          'span',
          null,
          h('strong', null, 'Hors connexion. '),
          'Seules les instances déjà installées peuvent être lancées. En solo, un compte Microsoft fonctionne avec la dernière session.',
        ),
      ),
    instanceBlock(instance, status, details),
    instance.playtime > 0 && statsTiles(instance),
    instance.modpack && modpackCard(instance, busy),
  ];
}

function stepDetail(step, index, run, instance, details) {
  const counted = run.step === index && run.total > 0;
  if (index === FILES_STEP && counted) return `${run.done.toLocaleString('fr-FR')} / ${run.total.toLocaleString('fr-FR')} fichiers`;
  if (index === JAVA_STEP) return counted ? `${javaLabel(details)} : ${run.done} / ${run.total} fichiers` : `${javaLabel(details)} · runtime Mojang`;
  if (index === MEMORY_STEP) return `${formatGo(instance.settings.ram)} demandés`;
  if (index === LOADER_STEP && instance.loader !== 'vanilla') return counted ? `${loaderLabel(instance)} : ${run.done} / ${run.total} fichiers` : loaderLabel(instance);
  return step.detail;
}

function progressPanel(instance, details) {
  const run = state.run;
  const percent = runPercent(run);
  const title = run.prepareOnly ? 'Vérification de' : instance.installed ? 'Lancement de' : 'Installation de';
  return [
    h('h2', { class: 'home__heading' }, `${title} Minecraft ${instance.version}`, h('span', { class: 'home__heading-value' }, `${percent} %`)),
    h(
      'div',
      { class: 'progress', role: 'progressbar', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Progression' },
      h('div', { class: 'progress__fill', style: `width:${percent}%` }),
    ),
    h(
      'p',
      { class: 'progress-stats' },
      h('span', null, `Étape ${run.step + 1} / ${LAUNCH_STEPS.length} : ${LAUNCH_STEPS[run.step].name}`),
      run.total > 0 && h('span', null, `${run.done.toLocaleString('fr-FR')} / ${run.total.toLocaleString('fr-FR')} fichiers`),
      h('button', { class: 'btn btn--ghost', style: 'height:28px;margin-left:auto;font-size:14px', onClick: stopGame }, 'Annuler'),
    ),
    h(
      'ol',
      { class: 'steps', 'aria-label': 'Étapes du lancement' },
      LAUNCH_STEPS.map((step, i) => {
        const kind = i < run.step ? 'done' : i === run.step ? 'active' : 'todo';
        return h(
          'li',
          { class: `step step--${kind}`, 'aria-current': kind === 'active' ? 'step' : null },
          h('span', { class: 'step__mark', 'aria-hidden': 'true' }, kind === 'done' && icon('check')),
          h('span', { class: 'step__body' }, h('span', { class: 'step__name' }, step.name), h('span', { class: 'step__detail' }, stepDetail(step, i, run, instance, details))),
        );
      }),
    ),
  ];
}

export function renderHome() {
  const instance = selectedInstance();
  if (!instance) {
    return h(
      'div',
      { class: 'empty' },
      h('h1', { class: 'empty__title' }, 'Aucune instance'),
      h('p', { class: 'empty__text' }, 'Une instance, c’est une installation de Minecraft avec ses propres mondes et réglages. Crée la première pour commencer.'),
      h('button', { class: 'btn btn--primary btn--lg', onClick: openNewInstance }, icon('plus'), 'Nouvelle instance'),
    );
  }
  const status = instanceStatus(instance);
  const details = versionDetails(instance.version);
  const quiet = status.kind === 'running' || status.kind === 'busy' || instance.loader === 'vanilla';
  if (!quiet) installedContent(instance, 'mods'); // contrôle à l'ouverture, ensuite gardé en mémoire
  return h(
    'div',
    null,
    hero(instance, status, details, quiet ? null : updatesCard(instance)),
    status.kind === 'busy'
      ? h('div', { class: 'home__content' }, h('section', { class: 'card' }, h('div', { class: 'stats' }, progressPanel(instance, details))))
      : h('div', { class: 'home__content' }, infoCards(instance, status, details)),
  );
}
