// Onglet Serveurs : la liste du menu Multijoueur de l'instance, avec ping en direct et connexion en un clic.
import { LOADER_NAMES } from '../data.js';
import { blockIcon, h, icon } from '../dom.js';
import { instanceServers, joinServer, moveServer, openServerDialog, pingAll, refreshServers, removeServer } from '../servers-actions.js';
import { activeAccount, selectedInstance, state } from '../state.js';

const number = new Intl.NumberFormat('fr-FR');

function serverIcon(src) {
  if (src) return h('img', { class: 'server-icon', src, alt: '' });
  return h('span', { class: 'server-icon server-icon--empty', 'aria-hidden': 'true' }, icon('servers', 28));
}

/** Barres de signal comme dans le jeu : 5 barres sous 150 ms, une seule au-delà d'une seconde. */
function signal(ping) {
  if (!ping || ping.loading) return h('span', { class: 'signal signal--wait', title: 'Ping en cours…' }, [1, 2, 3, 4, 5].map(() => h('span')));
  if (!ping.online) return h('span', { class: 'signal signal--off', title: ping.error }, icon('offline', 18));
  const latency = ping.latency;
  const bars = latency == null ? 3 : latency < 150 ? 5 : latency < 300 ? 4 : latency < 600 ? 3 : latency < 1000 ? 2 : 1;
  return h(
    'span',
    { class: 'signal', title: latency == null ? 'Latence inconnue' : `${latency} ms` },
    [1, 2, 3, 4, 5].map((i) => h('span', { class: i <= bars ? 'on' : '' })),
    h('span', { class: 'signal__ms' }, latency == null ? '—' : `${latency} ms`),
  );
}

const HEX = /^#[0-9A-F]{6}$/i;

/** MOTD en couleurs, segment par segment (texte uniquement, jamais de HTML). */
function motd(segments) {
  return h(
    'div',
    { class: 'motd' },
    segments.map((s) =>
      h(
        'span',
        {
          style: [
            HEX.test(s.color ?? '') && `color:${s.color}`,
            s.bold && 'font-weight:700',
            s.italic && 'font-style:italic',
            (s.underlined || s.strikethrough) && `text-decoration:${[s.underlined && 'underline', s.strikethrough && 'line-through'].filter(Boolean).join(' ')}`,
          ]
            .filter(Boolean)
            .join(';') || null,
        },
        s.text,
      ),
    ),
  );
}

function serverRow(instance, server, position, count, locked) {
  const ping = state.servers.pings[server.address];
  const online = ping?.online;
  const joining = state.run?.instanceId === instance.id && state.run?.server === server.address;
  const players = online && ping.players;

  return h(
    'div',
    { class: 'server-row' },
    h(
      'div',
      { class: 'server-row__order' },
      h('button', { class: 'icon-btn icon-btn--up', 'aria-label': `Monter ${server.name}`, disabled: locked || position === 0, onClick: () => moveServer(instance, server, -1) }, icon('chevron')),
      h('button', { class: 'icon-btn', 'aria-label': `Descendre ${server.name}`, disabled: locked || position === count - 1, onClick: () => moveServer(instance, server, 1) }, icon('chevron')),
    ),
    serverIcon(ping?.favicon ?? server.icon),
    h(
      'div',
      { class: 'server-row__body' },
      h(
        'div',
        { class: 'server-row__title' },
        h('span', null, server.name),
        players && h('span', { class: 'server-row__players', title: players.sample.join(', ') || null }, players.max ? `${number.format(players.online)} / ${number.format(players.max)}` : `${number.format(players.online)} en ligne`),
        signal(ping),
      ),
      online
        ? motd(ping.motd)
        : h('div', { class: `motd motd--muted${ping && !ping.loading ? ' motd--error' : ''}` }, ping?.loading || !ping ? 'Interrogation du serveur…' : ping.error),
      h(
        'div',
        { class: 'content-row__meta' },
        h('span', { class: 'mono' }, server.address),
        online && ping.version.name && h('span', { class: 'content-row__desc' }, ping.version.name),
      ),
    ),
    h(
      'button',
      {
        class: 'btn btn--primary',
        disabled: Boolean(state.run) || !activeAccount(),
        title: activeAccount() ? `Lancer ${instance.name} et rejoindre ${server.address}` : 'Ajoute un compte avant de jouer',
        onClick: () => joinServer(server),
      },
      icon('play'),
      joining ? (state.run.phase === 'running' ? 'En jeu' : 'Lancement…') : 'Rejoindre',
    ),
    h('button', { class: 'dialog__close', 'aria-label': `Modifier ${server.name}`, disabled: locked, onClick: () => openServerDialog(instance, server) }, icon('settings')),
    h('button', { class: 'dialog__close', 'aria-label': `Supprimer ${server.name}`, disabled: locked, onClick: () => removeServer(instance, server) }, icon('trash')),
  );
}

export function renderServers() {
  const instance = selectedInstance();
  if (!instance) {
    return h(
      'div',
      { class: 'empty' },
      h('h1', { class: 'empty__title' }, 'Aucune instance'),
      h('p', { class: 'empty__text' }, 'Crée une instance pour y ajouter tes serveurs.'),
    );
  }
  const running = state.run?.instanceId === instance.id;
  const data = instanceServers(instance);
  const items = data?.items ?? [];
  if (items.length) pingAll(instance);
  const pinging = items.some((s) => state.servers.pings[s.address]?.loading);

  let message = null;
  if (!data || (data.loading && !data.items)) message = 'Lecture de servers.dat…';
  else if (data.error) message = data.error;
  else if (!items.length) message = 'Aucun serveur pour l’instant. Ajoute ton premier serveur : il apparaîtra aussi dans le menu Multijoueur du jeu.';

  return h(
    'div',
    { class: 'mods-page' },
    h(
      'div',
      { class: 'mods-main' },
      h(
        'div',
        { class: 'page__head' },
        h('h1', { class: 'page__title' }, 'Serveurs'),
        h(
          'span',
          { class: 'mods-instance' },
          blockIcon(instance.icon, 'block--sm'),
          `${instance.name} · ${instance.version}${instance.loader !== 'vanilla' ? ` · ${LOADER_NAMES[instance.loader]}` : ''}`,
        ),
        h('span', { class: 'page__spacer' }),
        h('button', { class: 'btn btn--lg', disabled: pinging || !items.length, onClick: () => refreshServers(instance, { ping: true }) }, icon('refresh'), pinging ? 'Ping…' : 'Actualiser'),
        h('button', { class: 'btn btn--primary btn--lg', disabled: running, onClick: () => openServerDialog(instance) }, icon('plus'), 'Ajouter un serveur'),
      ),
      running && h('p', { class: 'offline-banner', style: 'margin:14px 0 0' }, icon('lock'), h('span', null, 'Le jeu est lancé : la liste est en lecture seule (le jeu réécrit servers.dat en quittant).')),
      h(
        'div',
        { class: 'content-list', 'data-scroll-key': 'servers' },
        message
          ? h('p', { class: 'vtable__empty' }, message)
          : items.map((server, position) => serverRow(instance, server, position, items.length, running)),
      ),
    ),
  );
}

