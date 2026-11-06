// Décor de la fenêtre : coucher de soleil par défaut, ou le fond choisi pour l'instance sélectionnée.
import { t } from './i18n.js';
import { sceneUrl } from './banner.js';
import { selectedInstance, state } from './state.js';

const DEFAULT_SEED = 120;
const $ = (id) => document.getElementById(id);

export const fondUrl = (instanceId, file) => `fond://${instanceId}/${file}`;

// Voile déjà présent sur le décor (.scene::after, en haut) et couleur de tous les voiles.
const VEIL = [12, 9, 26];
const BASE_ALPHA = 0.17;
const MAX_ALPHA = 0.8;
/** Contraste minimal du texte blanc (WCAG AA, texte normal). */
const MIN_CONTRAST = 4.5;

const linear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const veil = (px, alpha) => px.map((c, i) => c * (1 - alpha) + VEIL[i] * alpha);
export const dimAlpha = (dim) => (Math.min(100, Math.max(0, dim)) / 100) * MAX_ALPHA;

/** Contraste du texte blanc sur un pixel voilé par le voile de base puis par « Assombrir ». */
function contrastAt(px, dim) {
  return 1.05 / (luminance(veil(veil(px, BASE_ALPHA), dimAlpha(dim))) + 0.05);
}

const minimums = new Map();

/** Plus petit réglage « Assombrir » (0 à 100) qui garde 4,5:1 sur la zone du haut de l'image (les 40 % du haut, canvas réduit). */
export function minimumDim(url) {
  if (!minimums.has(url)) {
    minimums.set(
      url,
      new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onerror = () => reject(new Error(t('scene.impossible_de_lire_image')));
        img.onload = () => {
          try {
            resolve(dimForPixels(readTopPixels(img)));
          } catch (error) {
            reject(error);
          }
        };
        img.src = url;
      }),
    );
    minimums.get(url).catch(() => minimums.delete(url));
  }
  return minimums.get(url);
}

/** Pixels de la zone du haut, l'image étant cadrée comme à l'écran (remplissage centré, 16:9). */
function readTopPixels(img) {
  const W = 64;
  const H = 36;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#140c22'; // un PNG transparent laisse voir le fond de la fenêtre
  ctx.fillRect(0, 0, W, H);
  const scale = Math.max(W / img.naturalWidth, H / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
  const data = ctx.getImageData(0, 0, W, Math.ceil(H * 0.4)).data;
  const pixels = [];
  for (let i = 0; i < data.length; i += 4) pixels.push([data[i], data[i + 1], data[i + 2]]);
  return pixels;
}

/** On se cale sur le 90e centile le plus clair : quelques pixels très clairs isolés ne comptent pas, un ciel clair oui. */
export function dimForPixels(pixels) {
  const sorted = [...pixels].sort((a, b) => luminance(a) - luminance(b));
  const worst = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  for (let dim = 0; dim <= 100; dim++) if (contrastAt(worst, dim) >= MIN_CONTRAST) return dim;
  return 100;
}

/** Fond affiché pour l'instance : celui en cours de réglage si la fenêtre « Fond » est ouverte, sinon celui enregistré. */
function currentBackground(instance) {
  const modal = state.modal;
  if (instance && modal?.type === 'background' && modal.instanceId === instance.id) {
    const { kind, image, dim } = modal.draft;
    return { kind, image, dim: kind === 'image' ? Math.max(dim, modal.min) : dim };
  }
  return instance?.background ?? null;
}

const broken = new Set();
let applied = null;

/** Le décor suit l'instance sélectionnée ; une image manquante ramène au décor Coucher. */
export function renderScene() {
  if (!state.ready) return;
  const instance = selectedInstance();
  const seed = instance?.seed ?? DEFAULT_SEED;
  const bg = currentBackground(instance);
  const photo = bg?.kind === 'image' && bg.image ? fondUrl(instance.id, bg.image) : null;
  const usePhoto = photo && !broken.has(photo);
  const kind = bg && bg.kind !== 'image' ? bg.kind : 'sunset';
  const dim = bg && (usePhoto || bg.kind !== 'image') ? bg.dim ?? 0 : 0;
  const key = `${usePhoto ? photo : `${seed}:${kind}`}|${dim}`;
  if (key === applied) return;
  applied = key;

  const art = $('scene-art');
  art.classList.toggle('scene__art--photo', Boolean(usePhoto));
  art.onerror = usePhoto
    ? () => {
        broken.add(photo);
        applied = null;
        renderScene();
      }
    : null;
  const src = usePhoto ? photo : sceneUrl(seed, kind);
  if (art.getAttribute('src') !== src) art.src = src;
  $('scene-art').parentElement.style.setProperty('--scene-dim', String(dimAlpha(dim)));
}
