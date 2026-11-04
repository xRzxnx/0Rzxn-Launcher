'use strict';

// Captures d'écran d'une instance (dossier screenshots, touche F2 dans le jeu).
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const IMAGE = /\.(png|jpe?g)$/i;

const shotsDir = (gameDir) => path.join(gameDir, 'screenshots');

/** Nom de fichier reçu de l'interface ou d'une URL : une image du dossier, jamais un autre chemin. */
function shotFile(gameDir, file) {
  if (typeof file !== 'string' || file !== path.basename(file) || !IMAGE.test(file)) throw new Error('Capture invalide.');
  return path.join(shotsDir(gameDir), file);
}

/** Largeur et hauteur lues dans l'en-tête PNG (IHDR), sans décoder l'image. */
async function pngSize(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(24);
    await handle.read(head, 0, 24, 0);
    if (head.readUInt32BE(0) !== 0x89504e47 || head.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally {
    await handle.close();
  }
}

/** Captures, de la plus récente à la plus ancienne. */
async function listScreenshots(gameDir) {
  let names = [];
  try {
    names = (await fsp.readdir(shotsDir(gameDir))).filter((n) => IMAGE.test(n));
  } catch {
    return [];
  }
  const items = await Promise.all(
    names.map(async (file) => {
      const full = path.join(shotsDir(gameDir), file);
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat?.isFile()) return null;
      const size = /\.png$/i.test(file) ? await pngSize(full).catch(() => null) : null;
      return { file, size: stat.size, takenAt: stat.mtimeMs, width: size?.width ?? null, height: size?.height ?? null };
    }),
  );
  return items.filter(Boolean).sort((a, b) => b.takenAt - a.takenAt);
}

module.exports = { listScreenshots, shotFile, shotsDir };
