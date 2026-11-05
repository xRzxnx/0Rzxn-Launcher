// Bilan mensuel du temps de jeu, toutes instances confondues : calculs à partir de stats.days, navigation et enregistrement en image.
import { api } from './api.js';
import { state, toast, toastError, update } from './state.js';

const pad = (n) => String(n).padStart(2, '0');
const MONTH_NAME = new Intl.DateTimeFormat('fr-FR', { month: 'long' });

export const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const parseMonth = (key) => {
  const [y, m] = key.split('-').map(Number);
  return { y, m };
};
const daysIn = (key) => {
  const { y, m } = parseMonth(key);
  return new Date(y, m, 0).getDate();
};
const shiftKey = (key, delta) => {
  const { y, m } = parseMonth(key);
  return monthKey(new Date(y, m - 1 + delta, 1));
};

export const monthName = (key) => MONTH_NAME.format(new Date(parseMonth(key).y, parseMonth(key).m - 1, 1));
/** « de novembre », « d’avril » */
export const withDe = (name) => (/^[aeiouhéèêàâîôû]/i.test(name) ? `d’${name}` : `de ${name}`);

/** Total par jour (toutes instances) d'un mois : tableau indexé par jour - 1. */
function dayTotals(key) {
  const totals = Array.from({ length: daysIn(key) }, () => 0);
  for (const instance of state.instances) {
    for (const [day, minutes] of Object.entries(instance.stats?.days ?? {})) {
      if (day.slice(0, 7) !== key || !(minutes > 0)) continue;
      const index = Number(day.slice(8, 10)) - 1;
      if (index >= 0 && index < totals.length) totals[index] += minutes;
    }
  }
  return totals;
}

/** Plus longue série de jours consécutifs jouées dans un mois. */
export function longestStreak(totals) {
  let best = 0;
  let run = 0;
  for (const minutes of totals) {
    run = minutes > 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

/** Mois ayant des données (plus le mois en cours), du plus ancien au plus récent. */
export function recapMonths(now = new Date()) {
  const set = new Set([monthKey(now)]);
  for (const instance of state.instances) {
    for (const [day, minutes] of Object.entries(instance.stats?.days ?? {})) {
      if (minutes > 0 && /^\d{4}-\d{2}-\d{2}$/.test(day) && day.slice(0, 7) <= monthKey(now)) set.add(day.slice(0, 7));
    }
  }
  return [...set].sort();
}

/** Tout ce que la fenêtre et l'image affichent pour un mois. Rien n'est inventé : uniquement stats.days. */
export function computeRecap(key, now = new Date()) {
  const current = key === monthKey(now);
  const length = daysIn(key);
  const elapsed = current ? now.getDate() : length;
  const days = dayTotals(key);
  const total = days.reduce((a, b) => a + b, 0);
  const played = days.filter((m) => m > 0).length;

  const prevKey = shiftKey(key, -1);
  const prevDays = dayTotals(prevKey);
  // Mois en cours : on compare à la même date du mois précédent, pas à un mois entier.
  const prevTotal = prevDays.slice(0, current ? elapsed : prevDays.length).reduce((a, b) => a + b, 0);
  const delta = prevTotal > 0 ? Math.round(((total - prevTotal) / prevTotal) * 100) : null;

  const streak = longestStreak(days);
  const record = recapMonths(now).every((k) => k === key || longestStreak(dayTotals(k)) <= streak);

  const perInstance = state.instances
    .map((instance) => {
      let minutes = 0;
      for (const [day, value] of Object.entries(instance.stats?.days ?? {})) if (day.slice(0, 7) === key && value > 0) minutes += value;
      return { id: instance.id, name: instance.name, minutes };
    })
    .filter((entry) => entry.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 3)
    .map((entry) => ({ ...entry, share: Math.round((entry.minutes / total) * 100) }));

  return {
    key,
    name: monthName(key),
    year: parseMonth(key).y,
    current,
    empty: total <= 0,
    length,
    elapsed,
    days,
    todayIndex: current ? now.getDate() - 1 : -1,
    total: Math.round(total),
    played,
    streak,
    record: record && streak > 1,
    delta,
    prevName: monthName(prevKey),
    top: perInstance,
  };
}

export function openRecap() {
  update((s) => {
    s.modal = { type: 'recap', month: monthKey(new Date()), saving: false };
  });
}

/** Mois précédent (-1) ou suivant (+1) parmi ceux qui ont des données, jamais dans le futur. */
export function stepMonth(modal, direction) {
  const months = recapMonths();
  const index = months.indexOf(modal.month);
  const next = months[index + direction];
  if (next) update(() => { modal.month = next; });
}

/** Dessine le bilan sur un canvas, puis ouvre la fenêtre d'enregistrement native (processus principal). */
export async function saveRecapImage(modal) {
  if (modal.saving) return;
  update(() => { modal.saving = true; });
  try {
    const { renderRecapPng } = await import('./recap-image.js');
    const blob = await renderRecapPng(computeRecap(modal.month));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const file = await api.saveRecapImage(modal.month, bytes);
    if (file) toast({ kind: 'success', title: 'Bilan enregistré', text: file });
  } catch (error) {
    toastError('Bilan non enregistré', error);
  } finally {
    update(() => { modal.saving = false; });
  }
}
