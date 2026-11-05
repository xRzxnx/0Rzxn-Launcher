// Bannière « coucher de soleil » en pixel art, générée à partir d'une graine (une par instance).
// Le résultat est mis en cache sous forme d'image pour ne pas redessiner à chaque affichage.

const B = 10; // taille d'un pixel de la bannière
const SKY = ['#151129', '#1a1331', '#20163a', '#271943', '#2f1c4b', '#3a2053', '#47245a',
  '#562860', '#672d63', '#7a3363', '#8e3a60', '#a3445b', '#b65255', '#c6634f'];
const SUN_WIDTHS = [6, 10, 12, 14, 16, 16, 18, 18, 20];
const SUN_COLORS = ['#ffe6a3', '#ffdc93', '#ffd083', '#ffc274', '#ffb366', '#ffa45c', '#ff9853', '#ff8c4c', '#f98048'];
// Nuages : position, taille et numéro de couleur dans la palette.
const CLOUDS = [
  [0.14, 0.16, 14, 2, 0], [0.19, 0.1, 7, 1, 0],
  [0.56, 0.3, 18, 2, 1], [0.6, 0.25, 9, 1, 1],
  [0.8, 0.18, 15, 2, 2], [0.84, 0.13, 6, 1, 2],
];

/** Dégradé de n couleurs entre quelques teintes « #rrggbb ». */
function ramp(stops, n) {
  const rgb = stops.map((c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)));
  return Array.from({ length: n }, (_, i) => {
    const t = (i / (n - 1)) * (rgb.length - 1);
    const k = Math.min(rgb.length - 2, Math.floor(t));
    const u = t - k;
    return '#' + rgb[k].map((v, j) => Math.round(v * (1 - u) + rgb[k + 1][j] * u).toString(16).padStart(2, '0')).join('');
  });
}

// Palettes du décor : « sunset » est le décor d'origine, les autres en sont des variantes de couleurs.
const PALETTES = {
  sunset: {
    sky: SKY, sun: SUN_COLORS, star: '#e9dcff',
    clouds: ['#2c1c4b', '#7a3363', '#562860'],
    hills: ['#3a1f4d', '#251536', '#140c22'],
  },
  night: {
    sky: ramp(['#05070f', '#0d1530', '#1a2a57', '#2b4478'], SKY.length),
    sun: ['#fbfbf2', '#f4f4e6', '#ecedde', '#e2e6dc', '#d8dfdc', '#cdd7dc', '#c3cfdc', '#bac8dc', '#b0c0dc'],
    star: '#f2f5ff',
    clouds: ['#0f1936', '#27407a', '#1a2c58'],
    hills: ['#16244a', '#0d1634', '#060b1c'],
  },
  forest: {
    sky: ramp(['#0b1f17', '#1c4a33', '#3f8050', '#a8c46b'], SKY.length),
    sun: ['#fbf6c4', '#f6f0b0', '#f0e99e', '#e9e18c', '#e1d97c', '#d8d06e', '#cfc762', '#c5bd58', '#bab34f'],
    star: '#e4f7d0',
    clouds: ['#14352a', '#4e8f5c', '#2c6a43'],
    hills: ['#245238', '#17382a', '#0a2016'],
  },
};

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

function draw(seed, width, height, theme) {
  const pal = PALETTES[theme] ?? PALETTES.sunset;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const rnd = random(seed);
  const columns = Math.ceil(width / B);

  // Ciel en bandes, avec une rangée tramée entre chaque bande
  const bandH = height / pal.sky.length;
  pal.sky.forEach((color, i) => {
    const y = Math.round(i * bandH);
    ctx.fillStyle = color;
    ctx.fillRect(0, y, width, Math.ceil(bandH) + 1);
    if (i > 0) {
      ctx.fillStyle = pal.sky[i - 1];
      for (let x = 0; x < width; x += B * 2) ctx.fillRect(x, y, B, B);
    }
  });

  // Étoiles
  for (let i = 0; i < 14; i++) {
    ctx.globalAlpha = 0.35 + rnd() * 0.5;
    ctx.fillStyle = pal.star;
    ctx.fillRect(Math.round(rnd() * width), Math.round(rnd() * height * 0.22), B / 2, B / 2);
  }
  ctx.globalAlpha = 1;

  // Nuages
  for (const [x, y, w, hh, color] of CLOUDS) {
    ctx.fillStyle = pal.clouds[color];
    ctx.fillRect(Math.round(x * width), Math.round(y * height), w * B, hh * B);
  }

  // Soleil (posé derrière les montagnes, deux rayures horizontales)
  const sunCx = Math.round(width * 0.72);
  const sunBottom = Math.round(height * 0.7);
  SUN_WIDTHS.forEach((w, i) => {
    if (i === 5 || i === 7) return;
    ctx.fillStyle = pal.sun[i];
    const y = sunBottom - (SUN_WIDTHS.length - i) * B;
    ctx.fillRect(sunCx - (w * B) / 2, y, w * B, B);
  });

  // Reliefs, du plus lointain au plus proche
  const layers = [
    [smoothNoise(rnd, columns, 12, height * 0.24, height * 0.45), pal.hills[0]],
    [smoothNoise(rnd, columns, 8, height * 0.15, height * 0.33), pal.hills[1]],
  ];
  const near = smoothNoise(rnd, columns, 6, height * 0.06, height * 0.18);
  layers.push([near, pal.hills[2]]);
  for (const [heights, color] of layers) {
    ctx.fillStyle = color;
    heights.forEach((hh, i) => ctx.fillRect(i * B, height - hh, B, hh));
  }

  // Arbres sur les collines proches
  ctx.fillStyle = pal.hills[2];
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

export function bannerUrl(seed, width = 1600, height = 330, theme = 'sunset') {
  const key = `${theme}:${seed}:${width}x${height}`;
  if (!cache.has(key)) cache.set(key, draw(seed, width, height, theme));
  return cache.get(key);
}

/** Décor de toute la fenêtre : calé en haut, le fond de la scène prolonge le bas. Hauteur choisie pour que le soleil se lève à droite des boutons de l'accueil. */
export const sceneUrl = (seed, theme = 'sunset') => bannerUrl(seed, 1600, 760, theme);
