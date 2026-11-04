'use strict';

// Génère les icônes depuis src/renderer/assets/logo-mark.svg : build/icon.ico et build/icon.png (exe, installateur),
// src/main/assets/tray*.png (zone de notification). Le rendu passe par Chromium, d'où le lancement avec Electron.
// Usage : npm run icon
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const TILE = ['#8466ff', '#4326cf'];

// En 16 px, le tracé serait flou : même logo redessiné au pixel près.
const SMALL = [
  '................',
  '................',
  '...########.....',
  '..#...#...#.....',
  '..#...#...#.....',
  '..#...#...#.....',
  '..#...####......',
  '..#...#.#.......',
  '..#...#..#......',
  '..#...#...#.....',
  '...####....#....',
  '................',
  '.........####...',
  '................',
  '................',
  '................',
];

// S'exécute dans la page : dessine la tuile et le logo, renvoie les pixels RGBA et le PNG.
const RENDER = `async ({ size, mark, tile, small, dot }) => {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, tile[0]);
  gradient.addColorStop(1, tile[1]);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.22);
  ctx.fill();
  if (size === 16) {
    small.forEach((row, y) => [...row].forEach((c, x) => {
      if (c === '.') return;
      ctx.fillStyle = y === 12 ? '#3ddc84' : '#fff';
      ctx.fillRect(x, y, 1, 1);
    }));
  } else {
    const image = new Image();
    image.src = mark;
    await image.decode();
    ctx.drawImage(image, 0, 0, size, size);
  }
  if (dot) {
    const r = size * 0.23;
    ctx.fillStyle = '#11131c';
    ctx.beginPath();
    ctx.arc(size - r, size - r, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#3ddc84';
    ctx.beginPath();
    ctx.arc(size - r, size - r, r * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const png = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(blob);
  });
  return { png, rgba: size < 128 ? Array.from(ctx.getImageData(0, 0, size, size).data) : null };
}`;

/** Image BMP d'un .ico (BGRA de bas en haut, puis masque vide) : le format lu partout pour les petites tailles. */
function dib(size, rgba) {
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(size, 4);
  head.writeInt32LE(size * 2, 8);
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = ((size - 1 - y) * size + x) * 4;
      pixels[to] = rgba[from + 2];
      pixels[to + 1] = rgba[from + 1];
      pixels[to + 2] = rgba[from];
      pixels[to + 3] = rgba[from + 3];
    }
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  return Buffer.concat([head, pixels, mask]);
}

function ico(entries) {
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, data }, n) => {
    const at = 6 + n * 16;
    header[at] = size % 256;
    header[at + 1] = size % 256;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.data)]);
}

async function main() {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  const svg = fs.readFileSync(path.join(ROOT, 'src/renderer/assets/logo-mark.svg'));
  const mark = `data:image/svg+xml;base64,${svg.toString('base64')}`;
  const render = async (size, dot = false) => {
    const args = JSON.stringify({ size, mark, tile: TILE, small: SMALL, dot });
    const { png, rgba } = await win.webContents.executeJavaScript(`(${RENDER})(${args})`);
    return { png: Buffer.from(png, 'base64'), rgba };
  };

  const entries = [];
  for (const size of ICO_SIZES) {
    const { png, rgba } = await render(size);
    entries.push({ size, data: size >= 128 ? png : dib(size, rgba) });
  }
  fs.writeFileSync(path.join(ROOT, 'build/icon.ico'), ico(entries));
  fs.writeFileSync(path.join(ROOT, 'build/icon.png'), (await render(512)).png);

  const assets = path.join(ROOT, 'src/main/assets');
  fs.mkdirSync(assets, { recursive: true });
  for (const [name, dot] of [['tray', false], ['tray-playing', true]]) {
    fs.writeFileSync(path.join(assets, `${name}.png`), (await render(16, dot)).png);
    fs.writeFileSync(path.join(assets, `${name}@2x.png`), (await render(32, dot)).png);
  }
}

app
  .whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
