// Console : logs du launcher et du jeu, filtrables, et rapports de crash expliqués.
import { h, icon } from '../dom.js';
import { stopGame } from '../actions.js';
import { openCrashes } from '../crash-actions.js';
import { state, toast, update } from '../state.js';
import { renderCrashes } from './crashes.js';

function consoleTabs() {
  const count = state.crashes.list?.length ?? 0;
  const tab = (id, label, extra) =>
    h(
      'button',
      {
        role: 'tab',
        'aria-selected': state.console.tab === id ? 'true' : 'false',
        onClick: () => (id === 'crashes' ? openCrashes() : update((s) => { s.console.tab = 'logs'; })),
      },
      label,
      extra,
    );
  return h(
    'div',
    { class: 'segmented', role: 'tablist', 'aria-label': 'Vue de la console' },
    tab('logs', 'Logs'),
    tab('crashes', 'Rapports de crash', count > 0 && h('span', { class: 'segmented__count' }, count)),
  );
}

const FILTERS = [
  { id: 'all', label: 'Tout' },
  { id: 'launcher', label: 'Launcher' },
  { id: 'warn', label: 'Avertissements' },
  { id: 'error', label: 'Erreurs' },
];

function levelOf(line) {
  if (line.tag.endsWith('/ERROR') || line.tag.endsWith('/FATAL')) return 'error';
  if (line.tag === 'LAUNCHER') return 'launcher';
  if (line.tag.endsWith('/WARN')) return 'warn';
  return 'info';
}

function copyLogs() {
  const text = state.logs.map((l) => `[${l.time}] [${l.tag}]: ${l.msg}`).join('\n');
  navigator.clipboard.writeText(text).then(
    () => toast({ kind: 'success', title: 'Logs copiés', text: `${state.logs.length} lignes dans le presse-papiers.` }),
    () => toast({ kind: 'error', title: 'Copie impossible', text: "Le presse-papiers n'est pas accessible." }),
  );
}

export function renderConsole() {
  if (state.console.tab === 'crashes') {
    return h(
      'div',
      { class: 'page', style: 'height:100%' },
      h('div', { class: 'page__head' }, h('h1', { class: 'page__title' }, 'Console'), consoleTabs()),
      renderCrashes(),
    );
  }
  const run = state.run;
  const instance = run && state.instances.find((i) => i.id === run.instanceId);
  const counts = { all: state.logs.length, launcher: 0, warn: 0, error: 0 };
  for (const line of state.logs) {
    const level = levelOf(line);
    if (level in counts) counts[level] += 1;
  }
  const matching = state.logs.filter((l) => state.console.filter === 'all' || levelOf(l) === state.console.filter);
  // Seules les 500 dernières lignes sont dessinées, sauf demande (le bouton Copier prend tout).
  const lines = state.console.all ? matching : matching.slice(-500);
  const hidden = matching.length - lines.length;

  let pill;
  if (run?.phase === 'running') pill = { kind: 'running', text: `En jeu · ${instance?.name ?? ''} · ${instance?.version ?? ''}` };
  else if (run) pill = { kind: 'busy', text: `Préparation · ${instance?.name ?? ''}` };
  else pill = { kind: 'idle', text: 'Aucune partie en cours' };

  return h(
    'div',
    { class: 'page', style: 'height:100%' },
    h(
      'div',
      { class: 'page__head' },
      h('h1', { class: 'page__title' }, 'Console'),
      consoleTabs(),
      h('span', { class: `status-pill status-pill--${pill.kind}` }, h('span', { class: 'status-pill__dot', 'aria-hidden': 'true' }), pill.text),
      h('span', { class: 'page__spacer' }),
      h('button', { class: 'btn', onClick: copyLogs, disabled: state.logs.length === 0 }, icon('copy'), 'Copier'),
      h('button', { class: 'btn', onClick: () => update((s) => { s.logs = []; }), disabled: state.logs.length === 0 || !!run }, icon('trash'), 'Effacer'),
      run && h('button', { class: 'btn btn--danger', onClick: stopGame }, icon('stop'), run.phase === 'running' ? 'Arrêter le jeu' : 'Annuler'),
    ),
    h(
      'div',
      { class: 'console__filters' },
      FILTERS.map((f) =>
        h(
          'button',
          { class: 'chip', 'aria-pressed': state.console.filter === f.id ? 'true' : 'false', onClick: () => update((s) => { s.console.filter = f.id; }) },
          f.label,
          h('span', { class: 'chip__count' }, counts[f.id].toLocaleString('fr-FR')),
        ),
      ),
      h('span', { class: 'spacer' }),
      h('span', { class: 'console__auto', id: 'autoscroll-label' }, 'Défilement automatique'),
      h('button', {
        class: 'toggle',
        'aria-labelledby': 'autoscroll-label',
        'aria-pressed': state.console.autoscroll ? 'true' : 'false',
        onClick: () => update((s) => { s.console.autoscroll = !s.console.autoscroll; }),
      }),
    ),
    h(
      'div',
      { class: 'log', role: 'log', 'aria-label': 'Logs', 'data-scroll-key': 'console-log', 'data-autoscroll': state.console.autoscroll ? 'true' : null },
      hidden > 0 &&
        h('button', { class: 'btn btn--ghost btn--sm log__more', onClick: () => update((s) => { s.console.all = true; }) }, `Afficher les ${hidden.toLocaleString('fr-FR')} lignes plus anciennes`),
      lines.length === 0
        ? h('p', { class: 'log__empty' }, state.logs.length ? 'Aucune ligne pour ce filtre.' : "Lance une instance : ses logs s'afficheront ici.")
        : lines.map((l) =>
            h(
              'div',
              { class: `log__line log__line--${levelOf(l)}` },
              h('span', { class: 'log__time' }, l.time),
              h('span', { class: 'log__tag' }, `[${l.tag}]`),
              h('span', { class: 'log__msg' }, l.msg),
            ),
          ),
    ),
    h('p', { class: 'console__foot' }, 'Le jeton de connexion est masqué automatiquement dans les logs.'),
  );
}
