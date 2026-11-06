// Bilan du mois dessiné sur un canvas 1200 x 630 (fond sombre du launcher, Geist), sans dépendance.
import { t } from './i18n.js';
import { shortTime } from './views/home.js';
import { recapDays, recapDaysLabel, recapDeltaLabel, recapTitle } from './recap-actions.js';

export const RECAP_WIDTH = 1200;
export const RECAP_HEIGHT = 630;
const PAD = 56;
const FONT = "Geist, 'Segoe UI', system-ui, sans-serif";

function fit(ctx, text, width) {
  if (ctx.measureText(text).width <= width) return text;
  let cut = text.length;
  while (cut > 1 && ctx.measureText(`${text.slice(0, cut)}…`).width > width) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

function stats(recap) {
  const list = [
    [shortTime(recap.total), t('common.de_jeu')],
    [recapDays(recap.played), recapDaysLabel(recap)],
  ];
  if (recap.streak > 0) list.push([recapDays(recap.streak), recap.record ? t('common.de_suite_ton_record') : t('common.de_suite_au_maximum')]);
  if (recap.delta !== null) {
    list.push([`${recap.delta > 0 ? '+' : ''}${recap.delta} %`, recapDeltaLabel(recap)]);
  }
  return list;
}

/** PNG du bilan d'un mois (résultat de computeRecap, jamais vide). */
export async function renderRecapPng(recap) {
  await Promise.all(['500 20px Geist', '600 20px Geist'].map((font) => document.fonts.load(font).catch(() => {})));
  const canvas = document.createElement('canvas');
  canvas.width = RECAP_WIDTH;
  canvas.height = RECAP_HEIGHT;
  const ctx = canvas.getContext('2d');

  // Fond
  ctx.fillStyle = '#140c22';
  ctx.fillRect(0, 0, RECAP_WIDTH, RECAP_HEIGHT);
  const glow = ctx.createRadialGradient(1000, 0, 0, 1000, 0, 700);
  glow.addColorStop(0, 'rgba(109, 79, 240, 0.34)');
  glow.addColorStop(1, 'rgba(109, 79, 240, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, RECAP_WIDTH, RECAP_HEIGHT);

  ctx.textBaseline = 'alphabetic';
  // En-tête
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 46px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(recapTitle(recap.name, recap.year === new Date().getFullYear() ? '' : ` ${recap.year}`), PAD, 96);
  ctx.font = `500 22px ${FONT}`;
  ctx.fillStyle = '#d9d9ec';
  ctx.textAlign = 'right';
  ctx.fillText('0Rzxn_ Launcher', RECAP_WIDTH - PAD, 94);
  ctx.textAlign = 'left';

  // Chiffres clés
  const items = stats(recap);
  const col = (RECAP_WIDTH - PAD * 2) / items.length;
  items.forEach(([value, label], i) => {
    const x = PAD + i * col;
    ctx.font = `600 50px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(value, x, 172);
    ctx.font = `500 20px ${FONT}`;
    ctx.fillStyle = '#d9d9ec';
    // Libellé sur deux lignes au plus
    const words = label.split(' ');
    let line = '';
    const lines = [];
    for (const word of words) {
      if (line && ctx.measureText(`${line} ${word}`).width > col - 24) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
    lines.slice(0, 2).forEach((text, n) => ctx.fillText(text, x, 204 + n * 25));
  });

  // Barres par jour
  const top = 244;
  const base = 394;
  const gap = 6;
  const count = recap.length;
  const width = (RECAP_WIDTH - PAD * 2 - gap * (count - 1)) / count;
  const peak = Math.max(30, ...recap.days);
  recap.days.forEach((minutes, i) => {
    const x = PAD + i * (width + gap);
    const future = recap.current && i >= recap.elapsed;
    const height = minutes ? Math.max(8, Math.round((minutes / peak) * (base - top))) : 4;
    ctx.fillStyle = i === recap.todayIndex ? '#a892ff' : minutes ? 'rgba(255, 255, 255, 0.5)' : future ? 'rgba(255, 255, 255, 0.06)' : 'rgba(255, 255, 255, 0.16)';
    ctx.beginPath();
    ctx.roundRect(x, base - height, width, height, 3);
    ctx.fill();
  });

  // Instances les plus jouées
  const best = recap.top[0]?.minutes || 1;
  const barX = 330;
  const barW = 560;
  recap.top.forEach((entry, i) => {
    const y = 460 + i * 56;
    ctx.font = `500 24px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(fit(ctx, entry.name, 250), PAD, y + 8);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.beginPath();
    ctx.roundRect(barX, y - 10, barW, 14, 7);
    ctx.fill();
    ctx.fillStyle = '#a892ff';
    ctx.beginPath();
    ctx.roundRect(barX, y - 10, Math.max(14, (entry.minutes / best) * barW), 14, 7);
    ctx.fill();
    ctx.textAlign = 'right';
    ctx.fillStyle = '#d9d9ec';
    ctx.fillText(`${entry.share} %`, barX + barW + 90, y + 8);
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 24px ${FONT}`;
    ctx.fillText(shortTime(entry.minutes), RECAP_WIDTH - PAD, y + 8);
  });
  ctx.textAlign = 'left';

  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t('recap_image.image_impossible_creer')))), 'image/png'));
}
