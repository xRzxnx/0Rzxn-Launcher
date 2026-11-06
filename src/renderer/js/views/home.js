// Onglet Accueil : bannière de l'instance, bouton Jouer, cartes d'informations ou progression.
import { formatDateTime, num, t } from '../i18n.js';
import { createShortcut, duplicateInstance, openInstanceFolder, requestLaunch, saveSettings, stopGame, verifyInstance, versionDetails } from '../actions.js';
import { checkModpackUpdate, installedContent, pendingModUpdates, updateItems, updateModpack } from '../mods-actions.js';
import { openRecap } from '../recap-actions.js';
import { ramGuide,refreshFreeRam } from '../perf-actions.js';
import { FILES_STEP, JAVA_STEP, LAUNCH_STEPS, LOADER_NAMES, LOADER_STEP, MEMORY_STEP, formatLastPlayed, loaderLabel, ramRange, ramVerdict, ramZones } from '../data.js';
import { formatGo, formatPlaytime, formatShortTime, h, icon } from '../dom.js';
import { skinHead } from '../skin-view.js';
import { activeAccount, instanceAccount, instanceStatus, runPercent, selectedInstance, state, update } from '../state.js';
import { go, openNewInstance } from './chrome.js';

const javaLabel = (details) => (details ? `Java ${details.java}` : 'Java');

function playButton(instance, status) {
  if (!activeAccount()) return h('button', { class: 'play play--disabled', disabled: true }, t('common.aucun_compte'));
  if (status.kind === 'running') {
    return h('button', { class: 'play play--running', onClick: stopGame }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t('home.en_jeu_arreter'));
  }
  if (status.kind === 'busy') return h('button', { class: 'play play--busy', onClick: stopGame, title: t('common.annuler') }, status.label);
  if (state.run) return h('button', { class: 'play play--disabled', disabled: true }, t('home.une_autre_partie_tourne'));
  if (!instance.installed) {
    return h('button', { class: 'play play--install', onClick: () => requestLaunch() }, icon('download'), t('home.installer', { version: instance.version }));
  }
  return h('button', { class: 'play', onClick: () => requestLaunch() }, icon('play'), t('common.jouer'));
}

/** Rappel à côté de Jouer quand l'instance a son propre compte. */
function fixedAccount(instance) {
  const account = instanceAccount(instance);
  if (!account) return null;
  return h('span', { class: 'hero__account' }, skinHead(account, 28), h('span', null, t('home.toujours_avec', { name: account.name })));
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
    { class: 'upcard', 'aria-label': t('home.mises_jour_de_mods') },
    h('h3', { class: 'upcard__title' }, t('home.mises_jour', { count: items.length })),
    shown.map((item) =>
      h('div', { class: 'kv' }, h('span', { class: 'kv__name' }, item.title ?? item.name), h('b', { class: 'kv__ver' }, `${item.version ?? '?'} → ${item.update.number}`)),
    ),
    more > 0 && h('p', { class: 'upcard__more' }, t('home.et_autres', { count: more })),
    h('button', { class: 'btn btn--primary', disabled: busy, onClick: () => updateItems(instance, null, 'mods') }, icon('download'), busy ? t('home.mise_jour') : t('home.tout_mettre_jour')),
  );
}

function hero(instance, status, details, card) {
  const pillState = { ready: t('common.prete'), busy: status.label.split(' ·')[0], running: t('common.en_jeu'), idle: t('common.installer') }[status.kind];
  const lastPlayed = formatLastPlayed(instance.lastPlayedAt);
  const sub =
    status.kind === 'busy' && !instance.installed
      ? t('home.premiere_installation_quelques_centaines_de')
      : `${loaderLabel(instance)} · ${javaLabel(details)} · ${formatPlaytime(instance.playtime)}${instance.playtime ? t('home.de_jeu') : ''}`;

  return h(
    'section',
    { class: `hero${card ? ' hero--updates' : ''}`, 'aria-label': t('common.instance_2', { name: instance.name }) },
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
        lastPlayed && h('span', { class: 'status-pill' }, t('home.derniere_partie', { lastPlayed })),
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
        h('span', { class: 'version-box__body' }, h('span', { class: 'label' }, t('common.version')), h('span', { class: 'version-box__value' }, instance.version)),
      ),
      fixedAccount(instance),
      h('button', { class: 'btn btn--ghost', onClick: () => openInstanceFolder(instance.id) }, icon('folder'), t('home.ouvrir_le_dossier')),
    ),
  );
}

/** Instance issue d'un modpack : version installée et mise à jour. */
function modpackCard(instance, busy) {
  const pack = instance.modpack;
  const check = state.modpackUpdates[instance.id];
  let action;
  if (!pack.projectId) action = h('span', { class: 'hint' }, t('home.importe_depuis_un_fichier'));
  else if (check?.versionId) {
    action = h('button', { class: 'btn btn--primary', disabled: busy || Boolean(state.task), onClick: () => updateModpack(instance, check.versionId) }, icon('download'), t('common.mettre_jour_vers', { number: check.number }));
  } else {
    action = h('button', { class: 'btn btn--ghost', disabled: check?.checking, onClick: () => checkModpackUpdate(instance) }, check?.checking ? t('home.verification') : check?.none ? t('home.verifier_nouveau') : t('home.verifier_les_mises_jour'));
  }
  return h(
    'section',
    { class: 'card card__row' },
    pack.icon ? h('img', { class: 'content-icon', src: pack.icon, alt: '', style: 'width:44px;height:44px' }) : null,
    h(
      'div',
      { class: 'card__body' },
      h('h3', { class: 'card__title' }, t('home.modpack', { name: pack.name })),
      h('p', { class: 'card__text' }, t(check?.none ? 'home.pack_files_ok' : 'home.pack_files', { version: pack.version, count: pack.files?.length ?? 0 })),
    ),
    action,
  );
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const shortTime = formatShortTime;
const SINCE = { day: 'numeric', month: 'short' };

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
    { class: 'stat-tiles', 'aria-label': t('home.temps_de_jeu') },
    h(
      'div',
      { class: 'stat-tile', title: untracked > 0 ? t(instance.importedFrom ? 'home.untracked_imported' : 'home.untracked', { time: formatPlaytime(untracked) }) : null },
      h('span', { class: 'stat-tile__label' }, t('home.temps_de_jeu_au_total')),
      h('button', { class: 'stat-tile__link', title: t('home.voir_le_bilan_du_mois'), onClick: openRecap }, t('common.bilan_du_mois')),
      h('span', { class: 'stat-tile__row' }, h('span', { class: 'stat-tile__value' }, shortTime(instance.playtime)), !alone && h('span', { class: 'stat-tile__share' }, `${share} %`)),
      alone
        ? note(t('home.sur_cette_instance'))
        : h('span', { class: 'stat-tile__meter', role: 'img', 'aria-label': t('home.de_ton_temps_total', { share }) }, h('i', { style: `width:${share}%` })),
    ),
    statTile(
      t('home.derniers_jours'),
      shortTime(weekTotal),
      note(t('home.par_jour')),
      h(
        'span',
        { class: 'stat-tile__bars', 'aria-hidden': 'true' },
        week.map((minutes, i) => h('span', { class: `stat-tile__bar${minutes ? '' : ' stat-tile__bar--empty'}${i === 6 ? ' stat-tile__bar--today' : ''}`, style: `height:${Math.max(8, Math.round((minutes / peak) * 100))}%` })),
      ),
    ),
    statTile(stats.sessions > 1 ? t('home.parties') : t('home.partie'), String(stats.sessions), note(stats.since ? t('home.depuis_le', { value: formatDateTime(new Date(stats.since), SINCE) }) : stats.sessions ? t('home.au_total') : t('home.aucune_suivie'))),
    statTile(t('home.plus_longue_partie'), shortTime(stats.longest), note(stats.sessions ? t('home.average', { time: shortTime(tracked / stats.sessions) }) : t('home.pas_encore_de_moyenne'))),
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
      'aria-label': t('home.faire_tourner_le_bloc'),
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
    h('div', { class: 'ram-row' }, h('label', { class: 'spec-tile__label', for: 'home-ram' }, t('common.memoire')), badge),
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
            title: t('home.regler_sur', { ideal: formatGo(guide.ideal) }),
            onClick: () => update(() => {
              settings.ram = guide.ideal;
              saveSettings('instance', instance.id);
            }),
          },
          t('home.conseille', { guide: ramRange(guide) }),
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
  if (!guide.mods) return t('home.aucun');
  return t('home.mods_active', { count: guide.mods });
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
      'aria-label': t('common.instance'),
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
      h('button', { class: 'spec-tile', onClick: () => go('settings') }, h('span', { class: 'spec-tile__label' }, 'Java'), h('span', { class: 'spec-tile__value' }, custom ? t('common.personnalise') : javaLabel(details))),
    ),
    h(
      'div',
      { class: 'instance-block__actions' },
      blockAction('edit', t('home.modifier'), {
        disabled: busy,
        onClick: () => update((s) => { s.modal = { type: 'edit-instance', instanceId: instance.id, draft: { name: instance.name, icon: instance.icon, version: instance.version, loader: instance.loader, loaderVersion: instance.loaderVersion, group: instance.group ?? '', accountId: instance.accountId ?? null } }; }),
      }),
      blockAction('copy', t('home.dupliquer'), { disabled: busy, onClick: () => duplicateInstance(instance.id) }),
      blockAction('upload', t('home.exporter'), {
        onClick: () => update((s) => { s.modal = { type: 'export', instanceId: instance.id, draft: { name: instance.modpack?.name ?? instance.name, version: '1.0.0', summary: '' } }; }),
      }),
      blockAction('link', t('home.raccourci'), { onClick: () => createShortcut(instance.id) }),
      blockAction('shield', t('home.verifier'), { disabled: !instance.installed || Boolean(state.run), onClick: () => verifyInstance(instance.id) }),
      blockAction('trash', t('common.supprimer'), {
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
          h('strong', null, t('home.hors_connexion')),
          t('home.seules_les_instances_deja_installees'),
        ),
      ),
    instanceBlock(instance, status, details),
    instance.playtime > 0 && statsTiles(instance),
    instance.modpack && modpackCard(instance, busy),
  ];
}

function stepDetail(step, index, run, instance, details) {
  const counted = run.step === index && run.total > 0;
  if (index === FILES_STEP && counted) return t('home.fichiers', { done: num(run.done), total: num(run.total) });
  if (index === JAVA_STEP) return counted ? t('home.fichiers_2', { details: javaLabel(details), done: run.done, total: run.total }) : t('home.runtime_mojang', { details: javaLabel(details) });
  if (index === MEMORY_STEP) return t('home.demandes', { ram: formatGo(instance.settings.ram) });
  if (index === LOADER_STEP && instance.loader !== 'vanilla') return counted ? t('home.fichiers_3', { instance: loaderLabel(instance), done: run.done, total: run.total }) : loaderLabel(instance);
  return step.detail;
}

function progressPanel(instance, details) {
  const run = state.run;
  const percent = runPercent(run);
  const title = run.prepareOnly ? 'home.verifying_mc' : instance.installed ? 'home.launching_mc' : 'home.installing_mc';
  return [
    h('h2', { class: 'home__heading' }, t(title, { version: instance.version }), h('span', { class: 'home__heading-value' }, `${percent} %`)),
    h(
      'div',
      { class: 'progress', role: 'progressbar', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': t('home.progression') },
      h('div', { class: 'progress__fill', style: `width:${percent}%` }),
    ),
    h(
      'p',
      { class: 'progress-stats' },
      h('span', null, t('home.etape', { step: run.step + 1, LAUNCH_STEPS: LAUNCH_STEPS.length, name: LAUNCH_STEPS[run.step].name })),
      run.total > 0 && h('span', null, t('home.fichiers', { done: num(run.done), total: num(run.total) })),
      h('button', { class: 'btn btn--ghost', style: 'height:28px;margin-left:auto;font-size:14px', onClick: stopGame }, t('common.annuler')),
    ),
    h(
      'ol',
      { class: 'steps', 'aria-label': t('home.etapes_du_lancement') },
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
      h('h1', { class: 'empty__title' }, t('common.aucune_instance')),
      h('p', { class: 'empty__text' }, t('home.une_instance_est_une_installation')),
      h('button', { class: 'btn btn--primary btn--lg', onClick: openNewInstance }, icon('plus'), t('common.nouvelle_instance')),
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
