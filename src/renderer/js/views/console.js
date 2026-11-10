// Console : logs du launcher et du jeu, filtrables, et rapports de crash expliqués.
// Écran Preact (ui.js) : à chaque paquet de logs, seules les nouvelles lignes sont ajoutées.
import { num, t } from '../i18n.js';
import { h, icon } from '../ui.js';
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
    { class: 'segmented', role: 'tablist', 'aria-label': t('console.vue_de_la_console') },
    tab('logs', t('console.logs')),
    tab('crashes', t('console.rapports_de_crash'), count > 0 && h('span', { class: 'segmented__count' }, count)),
  );
}

const FILTERS = [
  { id: 'all', get label() { return t('common.tout'); } },
  { id: 'launcher', label: 'Launcher' },
  { id: 'warn', get label() { return t('console.avertissements'); } },
  { id: 'error', get label() { return t('console.erreurs'); } },
];

// Clé stable de chaque ligne (l'objet reçu du processus principal) : Preact ajoute et retire des lignes au lieu de toutes les réécrire.
const lineKeys = new WeakMap();
let nextKey = 0;
function keyOf(line) {
  let key = lineKeys.get(line);
  if (key === undefined) lineKeys.set(line, (key = ++nextKey));
  return key;
}

function levelOf(line) {
  if (line.tag.endsWith('/ERROR') || line.tag.endsWith('/FATAL')) return 'error';
  if (line.tag === 'LAUNCHER') return 'launcher';
  if (line.tag.endsWith('/WARN')) return 'warn';
  return 'info';
}

function copyLogs() {
  const text = state.logs.map((l) => `[${l.time}] [${l.tag}]: ${l.msg}`).join('\n');
  navigator.clipboard.writeText(text).then(
    () => toast({ kind: 'success', title: t('console.logs_copies'), text: t('console.lignes_dans_le_presse_papiers', { logs: state.logs.length }) }),
    () => toast({ kind: 'error', title: t('common.copie_impossible'), text: t('common.le_presse_papiers_est_pas') }),
  );
}

export function renderConsole() {
  if (state.console.tab === 'crashes') {
    return h(
      'div',
      { class: 'page', style: 'height:100%' },
      h('div', { class: 'page__head' }, h('h1', { class: 'page__title' }, t('common.console')), consoleTabs()),
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
  if (run?.phase === 'running') pill = { kind: 'running', text: t('console.en_jeu', { name: instance?.name ?? '', version: instance?.version ?? '' }) };
  else if (run) pill = { kind: 'busy', text: t('console.preparation', { name: instance?.name ?? '' }) };
  else pill = { kind: 'idle', text: t('console.aucune_partie_en_cours') };

  return h(
    'div',
    { class: 'page', style: 'height:100%' },
    h(
      'div',
      { class: 'page__head' },
      h('h1', { class: 'page__title' }, t('common.console')),
      consoleTabs(),
      h('span', { class: `status-pill status-pill--${pill.kind}` }, h('span', { class: 'status-pill__dot', 'aria-hidden': 'true' }), pill.text),
      h('span', { class: 'page__spacer' }),
      h('button', { class: 'btn', onClick: copyLogs, disabled: state.logs.length === 0 }, icon('copy'), t('common.copier')),
      h('button', { class: 'btn', onClick: () => update((s) => { s.logs = []; }), disabled: state.logs.length === 0 || !!run }, icon('trash'), t('console.effacer')),
      run && h('button', { class: 'btn btn--danger', onClick: stopGame }, icon('stop'), run.phase === 'running' ? t('common.arreter_le_jeu') : t('common.annuler')),
    ),
    h(
      'div',
      { class: 'console__filters' },
      FILTERS.map((f) =>
        h(
          'button',
          { class: 'chip', 'aria-pressed': state.console.filter === f.id ? 'true' : 'false', onClick: () => update((s) => { s.console.filter = f.id; }) },
          f.label,
          h('span', { class: 'chip__count' }, num(counts[f.id])),
        ),
      ),
      h('span', { class: 'spacer' }),
      h('span', { class: 'console__auto', id: 'autoscroll-label' }, t('console.defilement_automatique')),
      h('button', {
        class: 'toggle',
        'aria-labelledby': 'autoscroll-label',
        'aria-pressed': state.console.autoscroll ? 'true' : 'false',
        onClick: () => update((s) => { s.console.autoscroll = !s.console.autoscroll; }),
      }),
    ),
    h(
      'div',
      { class: 'log', role: 'log', 'aria-label': t('console.logs'), 'data-scroll-key': 'console-log', 'data-autoscroll': state.console.autoscroll ? 'true' : null },
      hidden > 0 &&
        h('button', { class: 'btn btn--ghost btn--sm log__more', onClick: () => update((s) => { s.console.all = true; }) }, t('console.afficher_les_lignes_plus_anciennes', { hidden: num(hidden) })),
      lines.length === 0
        ? h('p', { class: 'log__empty' }, state.logs.length ? t('console.aucune_ligne_pour_ce_filtre') : t('console.lance_une_instance_ses_logs'))
        : lines.map((l) =>
            h(
              'div',
              { key: keyOf(l), class: `log__line log__line--${levelOf(l)}` },
              h('span', { class: 'log__time' }, l.time),
              h('span', { class: 'log__tag' }, `[${l.tag}]`),
              h('span', { class: 'log__msg' }, l.msg),
            ),
          ),
    ),
    h('p', { class: 'console__foot' }, t('console.le_jeton_de_connexion_est')),
  );
}
