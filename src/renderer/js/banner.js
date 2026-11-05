// Bannière « coucher de soleil » en pixel art, générée à partir d'une graine (une par instance).
// Le résultat est mis en cache sous forme d'image pour ne pas redessiner à chaque affichage.

const B = 10; // taille d'un pixel de la bannière
const SKY = ['#151129', '#1a1331', '#20163a', '#271943', '#2f1c4b', '#3a2053', '#47245a',
  '#562860', '#672d63', '#7a3363', '#8e3a60', '#a3445b', '#b65255', '#c6634f'];
const SUN_WIDTHS = [6, 10, 12, 14, 16, 16, 18, 18, 20];
const SUN_COLORS = ['#ffe6a3', '#ffdc93', '#ffd083', '#ffc274', '#ffb366', '#ffa45c', '#ff9853', '#ff8c4c', '#f98048'];
const CLOUDS = [
  [0.14, 0.16, 14, 2, '#2c1c4b'], [0.19, 0.1, 7, 1, '#2c1c4b'],
  [0.56, 0.3, 18, 2, '#7a3363'], [0.6, 0.25, 9, 1, '#7a3363'],
  [0.8, 0.18, 15, 2, '#562860'], [0.84, 0.13, 6, 1, '#562860'],
];

const cache = new Map();

function random(seed) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothNoise(rnd, columns, step, min, max) {
  const points = [];
  for (let i = 0; i <= Math.ceil(columns / step) + 1; i++) points.push(min + rnd() * (max - min));
  const out = [];
  for (let i = 0; i < columns; i++) {
    const k = Math.floor(i / step);
    const u = (1 - Math.cos(((i % step) / step) * Math.PI)) / 2;
    out.push(Math.max(1, Math.round((points[k] * (1 - u) + points[k + 1] * u) / B)) * B);
  }
  return out;
}

function draw(seed, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const rnd = random(seed);
  const columns = Math.ceil(width / B);

  // Ciel en bandes, avec une rangée tramée entre chaque bande
  const bandH = height / SKY.length;
  SKY.forEach((color, i) => {
    const y = Math.round(i * bandH);
    ctx.fillStyle = color;
    ctx.fillRect(0, y, width, Math.ceil(bandH) + 1);
    if (i > 0) {
      ctx.fillStyle = SKY[i - 1];
      for (let x = 0; x < width; x += B * 2) ctx.fillRect(x, y, B, B);
    }
  });

  // Étoiles
  for (let i = 0; i < 14; i++) {
    ctx.globalAlpha = 0.35 + rnd() * 0.5;
    ctx.fillStyle = '#e9dcff';
    ctx.fillRect(Math.round(rnd() * width), Math.round(rnd() * height * 0.22), B / 2, B / 2);
  }
  ctx.globalAlpha = 1;

  // Nuages
  for (const [x, y, w, hh, color] of CLOUDS) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x * width), Math.round(y * height), w * B, hh * B);
  }

  // Soleil (posé derrière les montagnes, deux rayures horizontales)
  const sunCx = Math.round(width * 0.72);
  const sunBottom = Math.round(height * 0.7);
  SUN_WIDTHS.forEach((w, i) => {
    if (i === 5 || i === 7) return;
    ctx.fillStyle = SUN_COLORS[i];
    const y = sunBottom - (SUN_WIDTHS.length - i) * B;
    ctx.fillRect(sunCx - (w * B) / 2, y, w * B, B);
  });

  // Reliefs, du plus lointain au plus proche
  const layers = [
    [smoothNoise(rnd, columns, 12, height * 0.24, height * 0.45), '#3a1f4d'],
    [smoothNoise(rnd, columns, 8, height * 0.15, height * 0.33), '#251536'],
  ];
  const near = smoothNoise(rnd, columns, 6, height * 0.06, height * 0.18);
  layers.push([near, '#140c22']);
  for (const [heights, color] of layers) {
    ctx.fillStyle = color;
    heights.forEach((hh, i) => ctx.fillRect(i * B, height - hh, B, hh));
  }

  // Arbres sur les collines proches
  ctx.fillStyle = '#140c22';
  for (const ratio of [0.075, 0.17, 0.21, 0.36, 0.57, 0.65]) {
    const col = Math.floor(ratio * columns);
    const x = (col - 1) * B;
    const base = height - near[col];
    ctx.fillRect(x + B, base - 7 * B, B, B);
    ctx.fillRect(x, base - 6 * B, 3 * B, 3 * B);
    ctx.fillRect(x + B, base - 3 * B, B, 3 * B);
  }

  return canvas.toDataURL('image/png');
}

export function bannerUrl(seed, width = 1600, height = 330) {
  const key = `${seed}:${width}x${height}`;
  if (!cache.has(key)) cache.set(key, draw(seed, width, height));
  return cache.get(key);
}

/** Décor de toute la fenêtre : calé en haut, le fond de la scène prolonge le bas. Hauteur choisie pour que le soleil se lève à droite des boutons de l'accueil. */
export const sceneUrl = (seed) => bannerUrl(seed, 1600, 760);
