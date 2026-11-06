'use strict';

// Images du menu Cristal, dessinées sans dépendance : panorama à 6 faces, verre, boutons et logo.
// Le décor reprend les palettes de src/renderer/js/banner.js, étendu sur 360° et sans raccord visible.
const zlib = require('node:zlib');

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

/** Dégradé de n couleurs [r, g, b] entre quelques teintes. */
function ramp(stops, n) {
  const rgb = stops.map(hex);
  return Array.from({ length: n }, (_, i) => {
    const t = (i / (n - 1)) * (rgb.length - 1);
    const k = Math.min(rgb.length - 2, Math.floor(t));
    const u = t - k;
    return rgb[k].map((v, j) => Math.round(v * (1 - u) + rgb[k + 1][j] * u));
  });
}

const SKY = ['#151129', '#1a1331', '#20163a', '#271943', '#2f1c4b', '#3a2053', '#47245a', '#562860', '#672d63', '#7a3363', '#8e3a60', '#a3445b', '#b65255', '#c6634f'];
const PALETTES = {
  sunset: {
    sky: SKY.map(hex),
    sun: ['#ffe6a3', '#ffdc93', '#ffd083', '#ffc274', '#ffb366', '#ffa45c', '#ff9853', '#ff8c4c', '#f98048'].map(hex),
    star: hex('#e9dcff'),
    clouds: ['#2c1c4b', '#7a3363', '#562860'].map(hex),
    hills: ['#3a1f4d', '#251536', '#140c22'].map(hex),
  },
  night: {
    sky: ramp(['#05070f', '#0d1530', '#1a2a57', '#2b4478'], SKY.length),
    sun: ['#fbfbf2', '#f4f4e6', '#ecedde', '#e2e6dc', '#d8dfdc', '#cdd7dc', '#c3cfdc', '#bac8dc', '#b0c0dc'].map(hex),
    star: hex('#f2f5ff'),
    clouds: ['#0f1936', '#27407a', '#1a2c58'].map(hex),
    hills: ['#16244a', '#0d1634', '#060b1c'].map(hex),
  },
  forest: {
    sky: ramp(['#0b1f17', '#1c4a33', '#3f8050', '#a8c46b'], SKY.length),
    sun: ['#fbf6c4', '#f6f0b0', '#f0e99e', '#e9e18c', '#e1d97c', '#d8d06e', '#cfc762', '#c5bd58', '#bab34f'].map(hex),
    star: hex('#e4f7d0'),
    clouds: ['#14352a', '#4e8f5c', '#2c6a43'].map(hex),
    hills: ['#245238', '#17382a', '#0a2016'].map(hex),
  },
};

const SUN_WIDTHS = [6, 10, 12, 14, 16, 16, 18, 18, 20];

// ---------- PNG ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = ~0;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode une image RGBA (Buffer de largeur × hauteur × 4 octets). */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8 bits par canal
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- Panorama ----------

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

/** Bruit doux qui reboucle, pour que le relief se raccorde après un tour complet. */
function loopNoise(rnd, columns, block, step, min, max) {
  const count = Math.round(columns / step);
  const points = Array.from({ length: count }, () => min + rnd() * (max - min));
  return Array.from({ length: columns }, (_, i) => {
    const k = Math.floor(i / step);
    const u = (1 - Math.cos(((i % step) / step) * Math.PI)) / 2;
    return Math.round((points[k % count] * (1 - u) + points[(k + 1) % count] * u) / block) * block;
  });
}

/**
 * Six faces carrées, dans l'ordre attendu par Minecraft :
 * 0 à 3 forment le tour de l'horizon, 4 est le haut et 5 le bas.
 */
function panoramaFaces(seed = 1, theme = 'sunset', size = 1024) {
  const pal = PALETTES[theme] ?? PALETTES.sunset;
  const rnd = random(seed);
  const block = Math.max(2, Math.round(size / 170)); // taille d'un pixel du décor
  const unit = size / 80; // mesure du décor, indépendante de la taille des pixels
  const snap = (v) => Math.max(block, Math.round(v / block) * block);
  const stepOf = (share) => Math.max(2, Math.round((size * share) / block));
  const ringWidth = size * 4;
  const columns = Math.ceil(ringWidth / block);
  const ring = Buffer.alloc(ringWidth * size * 4);

  const blend = (x, y, color, alpha = 1) => {
    if (y < 0 || y >= size) return;
    const i = (y * ringWidth + (((x % ringWidth) + ringWidth) % ringWidth)) * 4;
    for (let j = 0; j < 3; j++) ring[i + j] = Math.round(color[j] * alpha + ring[i + j] * (1 - alpha));
    ring[i + 3] = 255;
  };
  const rect = (x, y, w, h, color, alpha) => {
    for (let b = 0; b < h; b++) for (let a = 0; a < w; a++) blend(x + a, y + b, color, alpha);
  };

  // Ciel en bandes tramées, jusqu'à l'horizon
  const horizon = Math.round(size * 0.74);
  const band = horizon / pal.sky.length;
  pal.sky.forEach((color, i) => {
    const y = Math.round(i * band);
    rect(0, y, ringWidth, Math.ceil(band) + 1, color);
    if (i > 0) for (let x = 0; x < ringWidth; x += block * 2) rect(x, y, block, block, pal.sky[i - 1]);
  });
  rect(0, horizon, ringWidth, size - horizon, pal.sky[pal.sky.length - 1]);

  // Étoiles
  const star = Math.max(2, Math.round(block / 2));
  for (let i = 0; i < 70; i++) {
    rect(Math.floor((rnd() * ringWidth) / star) * star, Math.floor((rnd() * size * 0.3) / star) * star, star, star, pal.star, 0.35 + rnd() * 0.5);
  }

  // Nuages
  for (let i = 0; i < 16; i++) {
    const x = Math.floor(rnd() * columns) * block;
    const y = Math.floor(((0.12 + rnd() * 0.34) * size) / block) * block;
    const w = snap((8 + Math.floor(rnd() * 14)) * unit);
    const h = snap(unit);
    rect(x, y, w, 2 * h, pal.clouds[i % 3]);
    rect(x + snap(3 * unit), y - h, snap(w * 0.45), h, pal.clouds[i % 3]);
  }

  // Soleil ou lune, sur la première face
  const sunBottom = Math.round(size * 0.66);
  SUN_WIDTHS.forEach((w, i) => {
    if (i === 5 || i === 7) return; // deux rayures, comme la bannière
    const width = snap(w * unit * 1.5);
    const row = snap(unit * 1.4);
    rect(Math.round(size * 0.5 - width / 2), sunBottom - (SUN_WIDTHS.length - i) * row, width, row, pal.sun[i]);
  });

  // Reliefs, du plus lointain au plus proche, puis arbres
  const near = loopNoise(rnd, columns, block, stepOf(0.09), size * 0.7, size * 0.78);
  const layers = [
    [loopNoise(rnd, columns, block, stepOf(0.2), size * 0.52, size * 0.64), pal.hills[0]],
    [loopNoise(rnd, columns, block, stepOf(0.13), size * 0.6, size * 0.7), pal.hills[1]],
    [near, pal.hills[2]],
  ];
  for (const [tops, color] of layers) tops.forEach((top, i) => rect(i * block, top, block, size - top, color));
  for (let i = 0; i < 46; i++) {
    const col = Math.floor(rnd() * columns);
    const x = (col - 1) * block;
    const base = near[col];
    const s = snap((rnd() < 0.5 ? 0.6 : 1.1) * unit);
    rect(x + s, base - 7 * s, s, s, pal.hills[2]);
    rect(x, base - 6 * s, 3 * s, 3 * s, pal.hills[2]);
    rect(x + s, base - 3 * s, s, 3 * s, pal.hills[2]);
  }

  // Découpe du tour en quatre faces
  const faces = [];
  for (let n = 0; n < 4; n++) {
    const face = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) ring.copy(face, y * size * 4, (y * ringWidth + n * size) * 4, (y * ringWidth + (n + 1) * size) * 4);
    faces.push(encodePng(size, size, face));
  }

  // Haut étoilé et bas sombre
  const top = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) top.set([...pal.sky[0], 255], i * 4);
  for (let i = 0; i < 40; i++) {
    const x = Math.floor((rnd() * (size - star)) / star) * star;
    const y = Math.floor((rnd() * (size - star)) / star) * star;
    for (let b = 0; b < star; b++) for (let a = 0; a < star; a++) top.set([...pal.star, 255], ((y + b) * size + x + a) * 4);
  }
  faces.push(encodePng(size, size, top));
  const bottom = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) bottom.set([...pal.hills[2], 255], i * 4);
  faces.push(encodePng(size, size, bottom));
  return faces;
}

// ---------- Interface ----------

/** Pavé à coins arrondis, prévu pour être étiré en 9 parties. */
function roundedTile(size, radius, fill, border) {
  const data = Buffer.alloc(size * size * 4);
  const inside = (x, y, r, inset) => {
    const a = inset + r;
    const b = size - 1 - inset - r;
    const dx = x < a ? a - x : x > b ? x - b : 0;
    const dy = y < a ? a - y : y > b ? y - b : 0;
    return x >= inset && y >= inset && x <= size - 1 - inset && y <= size - 1 - inset && dx * dx + dy * dy <= r * r + 0.5;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inside(x, y, radius, 0)) continue;
      data.set(inside(x, y, radius - 1, 1) ? fill : border, (y * size + x) * 4);
    }
  }
  return encodePng(size, size, data);
}

const glassPanel = () => roundedTile(24, 5, [22, 15, 44, 190], [255, 255, 255, 64]);
const buttonImage = () => roundedTile(16, 3, [255, 255, 255, 34], [255, 255, 255, 86]);
const buttonHover = () => roundedTile(16, 3, [255, 255, 255, 64], [255, 255, 255, 230]);
const primaryImage = () => roundedTile(16, 3, [109, 79, 240, 245], [168, 146, 255, 255]);
const primaryHover = () => roundedTile(16, 3, [127, 100, 245, 255], [255, 255, 255, 255]);

const GLYPHS = {
  0: '01110 10001 10011 10101 11001 10001 01110',
  R: '11110 10001 10001 11110 10100 10010 10001',
  Z: '11111 00001 00010 00100 01000 10000 11111',
  X: '10001 10001 01010 00100 01010 10001 10001',
  N: '10001 11001 10101 10101 10011 10001 10001',
  _: '00000 00000 00000 00000 00000 00000 11111',
};

/** Logo « 0RZXN_ » en blocs violets. */
function logoImage() {
  const text = '0RZXN_';
  const cell = 14;
  const depth = 6;
  const width = (text.length * 6 - 1) * cell + depth;
  const height = 7 * cell + depth;
  const data = Buffer.alloc(width * height * 4);
  const rnd = random(3);
  const set = (x, y, color) => {
    if (x >= 0 && y >= 0 && x < width && y < height) data.set([...color, 255], (y * width + x) * 4);
  };
  const cells = [];
  [...text].forEach((ch, n) => GLYPHS[ch].split(' ').forEach((row, y) => [...row].forEach((on, x) => on === '1' && cells.push([n * 6 + x, y]))));
  const shades = ramp(['#ece6ff', '#c4b5ff', '#a892ff', '#7f64f5', '#6d4ff0'], 7);
  const shadow = hex('#2a1a66');
  for (const [x, y] of cells) {
    for (let d = depth; d > 0; d -= 2) for (let i = 0; i < cell; i++) for (let j = 0; j < cell; j++) set(x * cell + i + d, y * cell + j + d, shadow);
  }
  for (const [x, y] of cells) {
    const tone = (rnd() - 0.5) * 18;
    for (let i = 0; i < cell; i += 2) {
      for (let j = 0; j < cell; j += 2) {
        const edge = i === 0 || j === 0 ? 9 : i >= cell - 2 || j >= cell - 2 ? -9 : 0;
        const noise = (rnd() - 0.5) * 14 + tone + edge;
        const color = shades[y].map((v) => Math.max(0, Math.min(255, Math.round(v + noise))));
        for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) set(x * cell + i + a, y * cell + j + b, color);
      }
    }
  }
  return { png: encodePng(width, height, data), width, height };
}

module.exports = { encodePng, panoramaFaces, glassPanel, buttonImage, buttonHover, primaryImage, primaryHover, logoImage };
