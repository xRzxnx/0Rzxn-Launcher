// Onglet Accueil : bannière de l'instance, bouton Jouer, cartes d'informations ou progression.
import { createShortcut, duplicateInstance, openInstanceFolder, requestLaunch, stopGame, verifyInstance, versionDetails } from '../actions.js';
import { openImport } from '../import-actions.js';
import { checkModpackUpdate, updateModpack } from '../mods-actions.js';
import { bannerUrl } from '../banner.js';
import { FILES_STEP, JAVA_STEP, LAUNCH_STEPS, LOADER_NAMES, LOADER_STEP, MEMORY_STEP, formatLastPlayed, loaderLabel } from '../data.js';
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

function hero(instance, status, details) {
  const pillState = { ready: 'Prête', busy: status.label.split(' ·')[0], running: 'En jeu', idle: 'À installer' }[status.kind];
  const lastPlayed = formatLastPlayed(instance.lastPlayedAt);
  const sub =
    status.kind === 'busy' && !instance.installed
      ? 'Première installation : quelques centaines de Mo, partagés ensuite entre tes instances.'
      : `${loaderLabel(instance)} · ${javaLabel(details)} · ${formatPlaytime(instance.playtime)}${instance.playtime ? ' de jeu' : ''}`;
  const locked = status.kind === 'busy' || status.kind === 'running';

  return h(
    'section',
    { class: 'hero', 'aria-label': `Instance ${instance.name}` },
    h('img', { class: 'hero__art', src: bannerUrl(instance.seed), alt: '' }),
    h(
      'div',
      { class: 'hero__info' },
      h(
        'div',
        { class: 'hero__meta' },
        h(
          'span',
          { class: `status-pill status-pill--${status.kind}` },
          h('span', { class: 'status-pill__dot', 'aria-hidden': 'true' }),
          `Minecraft ${instance.version}${instance.loader !== 'vanilla' ? ` · ${LOADER_NAMES[instance.loader]}` : ''}`,
          h('span', { class: 'status-pill__sep', 'aria-hidden': 'true' }, '■'),
          h('span', { class: 'status-pill__state' }, pillState),
        ),
        lastPlayed && h('span', { class: 'hero__when' }, `Dernière partie ${lastPlayed}`),
      ),
      h('h1', { class: 'hero__title' }, instance.name),
      h('p', { class: 'hero__sub' }, sub),
    ),
    h(
      'div',
      { class: 'hero__bar' },
      h('button', { class: 'btn btn--ghost', onClick: () => openInstanceFolder(instance.id) }, 'Ouvrir le dossier'),
      h(
        'button',
        { class: 'version-box', disabled: locked, onClick: () => go('versions'), title: 'Voir les versions' },
        h('span', { class: 'version-box__body' }, h('span', { class: 'label' }, 'Version'), h('span', { class: 'version-box__value' }, instance.version)),
        !locked && icon('chevron'),
      ),
      fixedAccount(instance),
      playButton(instance, status),
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

const RANGES = [7, 14, 30];
const DAY_SHORT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const DAY_LONG = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shortTime = (minutes) => (minutes ? formatPlaytime(Math.round(minutes)).replace(' min', '').replace(/^(\d+)$/, '$1 min') : '0 min');

/** Temps de jeu : chiffres clés, minutes par jour, et part de l'instance parmi toutes. */
function statsCard(instance) {
  const range = state.home.statsRange;
  const stats = instance.stats ?? { days: {}, sessions: 0, longest: 0 };
  const today = new Date();
  const days = Array.from({ length: range }, (_, i) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (range - 1 - i));
    return { date, minutes: stats.days[dayKey(date)] ?? 0 };
  });
  const week = Array.from({ length: 7 }, (_, i) => stats.days[dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i))] ?? 0).reduce((a, b) => a + b, 0);
  const max = Math.max(30, ...days.map((d) => d.minutes));
  const tracked = Object.values(stats.days).reduce((a, b) => a + b, 0);
  const untracked = Math.max(0, Math.round(instance.playtime - tracked));
  const total = state.instances.reduce((sum, i) => sum + (i.playtime ?? 0), 0);
  const top = [...state.instances].sort((a, b) => (b.playtime ?? 0) - (a.playtime ?? 0))[0];
  const figures = [
    [formatPlaytime(instance.playtime).replace('jamais lancée', '0 min'), 'AU TOTAL'],
    [shortTime(week), '7 DERNIERS JOURS'],
    [String(stats.sessions), stats.sessions > 1 ? 'PARTIES' : 'PARTIE'],
    [shortTime(stats.longest), 'PLUS LONGUE'],
  ];
  const label = (d, i) => (i === range - 1 ? 'AUJ.' : DAY_SHORT.format(d.date).replace('.', '').toUpperCase());
  const ticks = [0, Math.floor((range - 1) / 2), range - 1];

  return h(
    'section',
    { class: 'card stats', 'aria-label': 'Temps de jeu' },
    h(
      'div',
      { class: 'stats__head' },
      h('h3', { class: 'card__title' }, 'Temps de jeu'),
      h(
        'div',
        { class: 'segmented segmented--sm', role: 'tablist', 'aria-label': 'Période' },
        RANGES.map((n) => h('button', { role: 'tab', 'aria-selected': n === range ? 'true' : 'false', onClick: () => update((s) => { s.home.statsRange = n; }) }, `${n} J`)),
      ),
    ),
    h(
      'div',
      { class: 'stats__body' },
      h('div', { class: 'stats__figures' }, figures.map(([value, name]) => h('div', { class: 'stats__figure' }, h('span', { class: 'stats__value' }, value), h('span', { class: 'stats__name' }, name)))),
      h(
        'div',
        { class: 'stats__chart' },
        h(
          'div',
          { class: 'stats__bars', role: 'img', 'aria-label': `Minutes de jeu par jour sur ${range} jours` },
          days.map((d, i) =>
            h('span', {
              class: `stats__bar${d.minutes ? '' : ' stats__bar--empty'}${i === range - 1 ? ' stats__bar--today' : ''}`,
              style: `height:${d.minutes ? Math.max(4, Math.round((d.minutes / max) * 100)) : 2}%`,
              title: `${DAY_LONG.format(d.date)} · ${shortTime(d.minutes)}`,
            }),
          ),
        ),
        h('div', { class: 'stats__axis' }, ticks.map((i) => h('span', null, label(days[i], i)))),
      ),
    ),
    h(
      'p',
      { class: 'stats__foot' },
      'Toutes tes instances : ',
      h('strong', null, formatPlaytime(total).replace('jamais lancée', '0 min')),
      top?.playtime && state.instances.length > 1 ? ` · ${top.name} en tête (${Math.round((top.playtime / total) * 100)} %)` : '',
      untracked > 0 ? ` · ${formatPlaytime(untracked)} ${instance.importedFrom ? 'reprises d’un autre launcher ou ' : ''}d’avant le suivi par jour.` : '',
    ),
  );
}

function infoCards(instance, details) {
  const s = instance.settings;
  const lastPlayed = formatLastPlayed(instance.lastPlayedAt);
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
    h('h2', { class: 'home__heading' }, icon(instance.installed ? 'check' : 'download'), instance.installed ? 'Prête à jouer' : 'Pas encore installée'),
    instance.playtime > 0 && statsCard(instance),
    h(
      'section',
      { class: 'card' },
      h('h3', { class: 'card__title' }, 'Instance'),
      h(
        'p',
        { class: 'card__text', style: 'margin-top:6px' },
        `${instance.name}${instance.group ? ` · groupe ${instance.group}` : ''} · ${formatPlaytime(instance.playtime)}${instance.playtime ? ' au total' : ''}${lastPlayed ? ` · dernière partie ${lastPlayed}` : ''}`,
      ),
      h(
        'div',
        { class: 'card__actions' },
        h(
          'button',
          {
            class: 'btn btn--ghost',
            disabled: busy,
            onClick: () => update((s) => { s.modal = { type: 'edit-instance', instanceId: instance.id, draft: { name: instance.name, icon: instance.icon, version: instance.version, loader: instance.loader, loaderVersion: instance.loaderVersion, group: instance.group ?? '', accountId: instance.accountId ?? null } }; }),
          },
          'Modifier…',
        ),
        h('button', { class: 'btn btn--ghost', disabled: busy, onClick: () => duplicateInstance(instance.id) }, 'Dupliquer'),
        h(
          'button',
          {
            class: 'btn btn--ghost',
            onClick: () => update((s) => { s.modal = { type: 'export', instanceId: instance.id, draft: { name: instance.modpack?.name ?? instance.name, version: '1.0.0', summary: '' } }; }),
          },
          'Exporter…',
        ),
        h('button', { class: 'btn btn--ghost', onClick: () => openImport('worlds') }, 'Importer des mondes…'),
        h('button', { class: 'btn btn--ghost', onClick: () => createShortcut(instance.id) }, 'Raccourci bureau'),
        h('button', { class: 'btn btn--ghost', onClick: () => openInstanceFolder(instance.id) }, 'Ouvrir le dossier'),
        h(
          'button',
          { class: 'btn btn--ghost btn--ghost-danger', disabled: busy, onClick: () => update((s) => { s.modal = { type: 'delete-instance', instanceId: instance.id }; }) },
          'Supprimer…',
        ),
      ),
    ),
    instance.modpack && modpackCard(instance, busy),
    h(
      'section',
      { class: 'card card__row' },
      h(
        'div',
        { class: 'card__body' },
        h('h3', { class: 'card__title' }, 'Ressources'),
        h(
          'p',
          { class: 'card__text' },
          instance.installed
            ? `Préparées pour Minecraft ${instance.version} · ${javaLabel(details)} · fichiers partagés entre instances`
            : `Téléchargées au premier lancement · ${javaLabel(details)} inclus`,
        ),
      ),
      instance.installed &&
        h('button', { class: 'btn btn--ghost', disabled: Boolean(state.run), onClick: () => verifyInstance(instance.id) }, 'Vérifier à nouveau'),
    ),
    h(
      'section',
      { class: 'card card__row' },
      h(
        'div',
        { class: 'card__body' },
        h('h3', { class: 'card__title' }, 'Mémoire et Java'),
        h(
          'p',
          { class: 'card__text' },
          `${formatGo(s.ram)} alloués · ${s.java === 'custom' && s.javaPath ? 'Java personnalisé' : `${javaLabel(details)} automatique (runtime Mojang)`}`,
        ),
      ),
      h('button', { class: 'btn btn--ghost', onClick: () => go('settings') }, 'Modifier…'),
    ),
    h(
      'section',
      { class: 'card card__row' },
      h(
        'div',
        { class: 'card__body' },
        h('h3', { class: 'card__title' }, 'Dossier du jeu'),
        h('p', { class: 'card__text mono' }, `~\\AppData\\Roaming\\.0rzxn\\instances\\${instance.id}\\minecraft`),
      ),
      h('button', { class: 'btn btn--ghost', onClick: () => openInstanceFolder(instance.id) }, 'Ouvrir…'),
    ),
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
  return h(
    'div',
    null,
    hero(instance, status, details),
    h('div', { class: 'home__content' }, status.kind === 'busy' ? progressPanel(instance, details) : infoCards(instance, details)),
  );
}
