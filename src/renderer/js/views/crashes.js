// Console › Rapports de crash : liste, explication de l'erreur, rapport complet, partage sur mclo.gs.
import { formatDateTime, num, t } from '../i18n.js';
import { askShare, copyCrash, crashKey, crashReport, openCrashFile, openCrashesFolder, runFix, selectCrash, selectedCrash } from '../crash-actions.js';
import { h, icon } from '../ui.js';
import { state } from '../state.js';

const TIME = { hour: '2-digit', minute: '2-digit' };
const DAY = { day: 'numeric', month: 'short' };
const MAX_LINES = 3000;

function when(timestamp) {
  const d = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const day = d.toDateString() === today.toDateString() ? t('crashes.aujourd_hui') : d.toDateString() === yesterday.toDateString() ? t('crashes.hier') : formatDateTime(d, DAY);
  return `${day} · ${formatDateTime(d, TIME)}`;
}

function reportItem(item) {
  const current = crashKey(item) === state.crashes.selected;
  return h(
    'button',
    { class: 'crash-item', 'aria-current': current ? 'true' : null, onClick: () => selectCrash(item) },
    h('span', { class: 'crash-item__when' }, h('span', { class: 'crash-item__dot', 'aria-hidden': 'true' }), when(item.at)),
    h('span', { class: 'crash-item__instance' }, item.instanceName),
    h('span', { class: 'crash-item__kind' }, [item.kind, item.label].filter(Boolean).join(' · ')),
  );
}

function problemCard(item, problem) {
  return h(
    'section',
    { class: `diagnosis${problem.id === 'unknown' ? ' diagnosis--unknown' : ''}`, 'aria-label': t('crashes.explication') },
    h('p', { class: 'diagnosis__label' }, icon(problem.id === 'unknown' ? 'info' : 'alert'), t('crashes.explication_2', { label: problem.label })),
    h('h2', { class: 'diagnosis__title' }, problem.title),
    h('p', { class: 'diagnosis__text' }, problem.text),
    h('p', { class: 'diagnosis__text' }, h('strong', null, t('crashes.que_faire')), problem.advice),
    problem.actions.length > 0 &&
      h(
        'div',
        { class: 'diagnosis__actions' },
        problem.actions.map((action, i) => {
          const busy = Boolean(state.crashes.shared[`${crashKey(item)}:${action.type}:${action.slug ?? action.modId}`]);
          return h(
            'button',
            { class: `btn ${i === 0 ? 'btn--primary' : action.type === 'mods' || action.type === 'settings' ? 'btn--ghost' : ''}`.trim(), disabled: busy, onClick: () => runFix(item, action) },
            action.type === 'install' && icon('download'),
            busy ? t('crashes.patiente') : action.label,
          );
        }),
      ),
  );
}

function shareStatus(item) {
  const shared = state.crashes.shared[crashKey(item)];
  if (!shared) return null;
  if (shared.loading) return h('p', { class: 'report__status', role: 'status' }, t('crashes.envoi_sur_mclo_gs'));
  if (shared.error) return h('p', { class: 'report__status report__status--error', role: 'alert' }, shared.error);
  return h(
    'p',
    { class: 'report__status report__status--ok', role: 'status' },
    h('span', { class: 'report__dot', 'aria-hidden': 'true' }),
    t('crashes.partage'),
    h('a', { href: shared.url, target: '_blank', rel: 'noreferrer', class: 'mono' }, shared.url.replace(/^https:\/\//, '')),
    h('span', { class: 'report__note' }, t(shared.copied ? 'crashes.shared_copied' : 'crashes.shared_masked')),
  );
}

function reportBox(item, report) {
  const all = report.text.split(/\r?\n/);
  const hidden = Math.max(0, all.length - MAX_LINES);
  const marked = new Set(report.problems.flatMap((p) => p.lines));
  const shown = all.slice(hidden);
  const first = Math.min(...[...marked].filter((n) => n >= hidden));
  return h(
    'section',
    { class: 'report', 'aria-label': t('crashes.rapport_complet') },
    h(
      'div',
      { class: 'report__bar' },
      h('span', { class: 'report__file mono' }, t('crashes.lignes', { file: item.file, all: num(all.length) })),
      h('button', { class: 'btn btn--ghost btn--sm', onClick: () => copyCrash(item) }, icon('copy'), t('common.copier')),
      h('button', { class: 'btn btn--ghost btn--sm', onClick: () => openCrashFile(item) }, t('crashes.ouvrir_le_fichier')),
      h('button', { class: 'btn btn--sm', disabled: state.crashes.shared[crashKey(item)]?.loading, onClick: () => askShare(item) }, icon('external'), t('crashes.partager_sur_mclo_gs')),
    ),
    shareStatus(item),
    h(
      'div',
      { class: 'report__text', 'data-scroll-key': `crash:${crashKey(item)}` },
      (hidden > 0 || report.truncated) && h('p', { class: 'report__cut' }, t('crashes.debut_du_rapport_masque_lignes', { hidden: num(hidden) })),
      shown.map((line, i) => {
        const hit = marked.has(i + hidden);
        // La première ligne en erreur est amenée à l'écran à l'ouverture du rapport (main.js).
        return h('div', { class: hit ? 'report__line report__line--hit' : 'report__line', 'data-scroll-first': hit && i + hidden === first ? 'true' : null }, line || ' ');
      }),
    ),
  );
}

export function renderCrashes() {
  const list = state.crashes.list;
  if (!list) return h('p', { class: 'vtable__empty' }, t('crashes.lecture_des_rapports'));
  if (!list.length) {
    return h(
      'div',
      { class: 'empty', style: 'flex:1' },
      h('h2', { class: 'empty__title', style: 'font-size:26px' }, t('crashes.aucun_crash')),
      h('p', { class: 'empty__text' }, t('crashes.quand_le_jeu_plante_le')),
    );
  }
  const item = selectedCrash() ?? list[0];
  const report = crashReport(item);
  let detail;
  if (report.loading) detail = h('p', { class: 'vtable__empty' }, t('crashes.lecture_du_rapport'));
  else if (report.error) detail = h('p', { class: 'vtable__empty' }, report.error);
  else detail = [...report.problems.map((p) => problemCard(item, p)), reportBox(item, report)];

  return h(
    'div',
    { class: 'crashes' },
    h(
      'nav',
      { class: 'crashes__list', 'aria-label': t('crashes.rapports'), 'data-scroll-key': 'crash-list' },
      list.map(reportItem),
      h('button', { class: 'btn btn--ghost', style: 'margin-top:4px', onClick: () => openCrashesFolder(item.instanceId) }, icon('folder'), t('crashes.dossier_crash_reports')),
    ),
    h('div', { class: 'crashes__detail' }, detail),
  );
}
