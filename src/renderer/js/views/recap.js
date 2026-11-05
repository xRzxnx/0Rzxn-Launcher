// Fenêtre « Ton mois de … » : bilan du temps de jeu d'un mois, toutes instances confondues.
import { computeRecap, recapMonths, saveRecapImage, stepMonth, withDe } from '../recap-actions.js';
import { h, icon } from '../dom.js';
import { close, dialog } from './modals.js';
import { shortTime } from './home.js';

const DAY = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' });

const big = (value, label) => h('div', { class: 'recap__stat' }, h('b', null, value), h('span', null, label));
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

function stats(recap) {
  const list = [
    big(shortTime(recap.total), 'de jeu'),
    big(plural(recap.played, 'jour'), `sur ${recap.current ? `${recap.elapsed} écoulés` : recap.length}`),
    big(plural(recap.streak, 'jour'), recap.record ? 'de suite, ton record' : 'de suite au maximum'),
  ];
  if (recap.delta !== null) list.push(big(`${recap.delta > 0 ? '+' : ''}${recap.delta} %`, `par rapport à ${recap.prevName}${recap.current ? ', à la même date' : ''}`));
  return h('div', { class: 'recap__stats' }, list);
}

function bars(recap) {
  const peak = Math.max(30, ...recap.days);
  return h(
    'div',
    { class: 'recap__bars', role: 'img', 'aria-label': `Temps de jeu par jour en ${recap.name}` },
    recap.days.map((minutes, i) => {
      const future = recap.current && i >= recap.elapsed;
      const cls = `recap__bar${minutes ? '' : ' recap__bar--empty'}${future ? ' recap__bar--future' : ''}${i === recap.todayIndex ? ' recap__bar--today' : ''}`;
      const title = `${DAY.format(new Date(recap.year, Number(recap.key.slice(5)) - 1, i + 1))} · ${shortTime(minutes)}`;
      return h('i', { class: cls, title, style: minutes ? `height:${Math.max(6, Math.round((minutes / peak) * 100))}%` : null });
    }),
  );
}

function top(recap) {
  return h(
    'div',
    { class: 'recap__top' },
    h('h2', { class: 'recap__sub' }, recap.top.length > 1 ? 'Instances les plus jouées' : 'Instance la plus jouée'),
    recap.top.map((entry) =>
      h(
        'div',
        { class: 'recap__row' },
        h('span', { class: 'recap__name' }, entry.name),
        h('span', { class: 'recap__meter', role: 'img', 'aria-label': `${entry.share} % du mois` }, h('i', { style: `width:${entry.share}%` })),
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
    h('button', { class: 'btn btn--ghost recap__arrow', 'aria-label': 'Mois précédent', disabled: index <= 0, onClick: () => stepMonth(modal, -1) }, icon('back', 18)),
    h('span', { class: 'recap__month' }, `${recap.name}${year}`, recap.current && h('small', null, 'en cours')),
    h('button', { class: 'btn btn--ghost recap__arrow', 'aria-label': 'Mois suivant', disabled: index >= months.length - 1, onClick: () => stepMonth(modal, 1) }, icon('next', 18)),
  );

  const content = recap.empty
    ? h('p', { class: 'recap__empty' }, `Aucune partie suivie en ${recap.name}${year}.`)
    : [
        stats(recap),
        bars(recap),
        top(recap),
        recap.current && h('p', { class: 'hint recap__note' }, `Le mois n’est pas terminé : ${recap.played} jour${recap.played > 1 ? 's' : ''} joué${recap.played > 1 ? 's' : ''} sur ${recap.elapsed} écoulés.`),
      ];

  return dialog({
    title: `Ton mois ${withDe(recap.name)}${year}`,
    size: 'dialog--wide',
    labelId: 'recap-title',
    body: [nav, content],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', disabled: recap.empty || modal.saving, onClick: () => saveRecapImage(modal) }, icon('download', 16), modal.saving ? 'Enregistrement…' : 'Enregistrer en image'),
      h('button', { class: 'btn btn--primary btn--lg', onClick: close }, 'Fermer'),
    ],
  });
}
