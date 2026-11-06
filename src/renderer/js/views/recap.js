// Fenêtre « Ton mois de … » : bilan du temps de jeu d'un mois, toutes instances confondues.
import { formatDateTime, t } from '../i18n.js';
import { computeRecap, recapDays, recapDaysLabel, recapDeltaLabel, recapMonths, recapTitle, saveRecapImage, stepMonth } from '../recap-actions.js';
import { h, icon } from '../dom.js';
import { close, dialog } from './modals.js';
import { shortTime } from './home.js';

const DAY = { day: 'numeric', month: 'long' };

const big = (value, label) => h('div', { class: 'recap__stat' }, h('b', null, value), h('span', null, label));

function stats(recap) {
  const list = [
    big(shortTime(recap.total), t('common.de_jeu')),
    big(recapDays(recap.played), recapDaysLabel(recap)),
    big(recapDays(recap.streak), recap.record ? t('common.de_suite_ton_record') : t('common.de_suite_au_maximum')),
  ];
  if (recap.delta !== null) list.push(big(`${recap.delta > 0 ? '+' : ''}${recap.delta} %`, recapDeltaLabel(recap)));
  return h('div', { class: 'recap__stats' }, list);
}

function bars(recap) {
  const peak = Math.max(30, ...recap.days);
  return h(
    'div',
    { class: 'recap__bars', role: 'img', 'aria-label': t('recap.temps_de_jeu_par_jour', { name: recap.name }) },
    recap.days.map((minutes, i) => {
      const future = recap.current && i >= recap.elapsed;
      const cls = `recap__bar${minutes ? '' : ' recap__bar--empty'}${future ? ' recap__bar--future' : ''}${i === recap.todayIndex ? ' recap__bar--today' : ''}`;
      const title = `${formatDateTime(new Date(recap.year, Number(recap.key.slice(5)) - 1, i + 1), DAY)} · ${shortTime(minutes)}`;
      return h('i', { class: cls, title, style: minutes ? `height:${Math.max(6, Math.round((minutes / peak) * 100))}%` : null });
    }),
  );
}

function top(recap) {
  return h(
    'div',
    { class: 'recap__top' },
    h('h2', { class: 'recap__sub' }, recap.top.length > 1 ? t('recap.instances_les_plus_jouees') : t('recap.instance_la_plus_jouee')),
    recap.top.map((entry) =>
      h(
        'div',
        { class: 'recap__row' },
        h('span', { class: 'recap__name' }, entry.name),
        h('span', { class: 'recap__meter', role: 'img', 'aria-label': t('recap.du_mois', { share: entry.share }) }, h('i', { style: `width:${entry.share}%` })),
        h('span', { class: 'recap__share' }, `${entry.share} %`),
        h('b', { class: 'recap__time' }, shortTime(entry.minutes)),
      ),
    ),
  );
}

export function recapDialog(modal) {
  const recap = computeRecap(modal.month);
  const months = recapMonths();
  const index = months.indexOf(modal.month);
  const year = recap.year === new Date().getFullYear() ? '' : ` ${recap.year}`;

  const nav = h(
    'div',
    { class: 'recap__nav' },
    h('button', { class: 'btn btn--ghost recap__arrow', 'aria-label': t('recap.mois_precedent'), disabled: index <= 0, onClick: () => stepMonth(modal, -1) }, icon('back', 18)),
    h('span', { class: 'recap__month' }, `${recap.name}${year}`, recap.current && h('small', null, t('recap.en_cours'))),
    h('button', { class: 'btn btn--ghost recap__arrow', 'aria-label': t('recap.mois_suivant'), disabled: index >= months.length - 1, onClick: () => stepMonth(modal, 1) }, icon('next', 18)),
  );

  const content = recap.empty
    ? h('p', { class: 'recap__empty' }, t('recap.none', { month: `${recap.name}${year}` }))
    : [
        stats(recap),
        bars(recap),
        top(recap),
        recap.current && h('p', { class: 'hint recap__note' }, t('recap.le_mois_est_pas_termine', { count: recap.played, elapsed: recap.elapsed })),
      ];

  return dialog({
    title: recapTitle(recap.name, year),
    size: 'dialog--wide',
    labelId: 'recap-title',
    body: [nav, content],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', disabled: recap.empty || modal.saving, onClick: () => saveRecapImage(modal) }, icon('download', 16), modal.saving ? t('recap.enregistrement') : t('recap.enregistrer_en_image')),
      h('button', { class: 'btn btn--primary btn--lg', onClick: close }, t('common.fermer')),
    ],
  });
}
