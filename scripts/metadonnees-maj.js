'use strict';

// Recalcule latest.yml et le .blockmap d'un installateur modifié après sa construction (signature) :
// sinon le launcher installé refuserait le fichier (sha512 différent de celui annoncé).
// Usage : node scripts/metadonnees-maj.js dist/0Rzxn_-Launcher-Setup-1.2.3.exe
const fs = require('node:fs');
const path = require('node:path');

/** Lit les champs simples de latest.yml (version, releaseDate) sans dépendance YAML. */
function readField(text, name) {
  const match = text.match(new RegExp(`^${name}: '?([^'\\n]+)'?$`, 'm'));
  return match ? match[1] : null;
}

/** Même forme que le latest.yml écrit par electron-builder 26 pour un installateur NSIS. */
function formatUpdateInfo({ version, url, sha512, size, releaseDate }) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${url}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${url}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n');
}

/**
 * Réécrit <installateur>.blockmap et latest.yml (même dossier) d'après les octets actuels de l'installateur.
 * La version et la date viennent du latest.yml existant, qui doit nommer ce même fichier.
 * @param {string} installer chemin de l'installateur
 * @param {{ buildBlockMap?: Function }} [deps]
 */
async function refreshUpdateInfo(installer, deps = {}) {
  const buildBlockMap = deps.buildBlockMap ?? require('app-builder-lib/out/targets/blockmap/blockmap').buildBlockMap;
  const dir = path.dirname(installer);
  const url = path.basename(installer);
  const ymlFile = path.join(dir, 'latest.yml');
  const previous = fs.readFileSync(ymlFile, 'utf8');
  const version = readField(previous, 'version');
  if (!version) throw new Error('latest.yml has no version.');
  if (readField(previous, 'path') !== url) throw new Error(`latest.yml does not describe ${url}.`);
  // Même format que celui d'electron-builder (gzip, découpage par défaut). Le blockmap ne sert qu'aux téléchargements
  // partiels : s'il est moins fin, electron-updater télécharge un peu plus, jamais un fichier faux.
  const { sha512, size } = await buildBlockMap(installer, 'gzip', `${installer}.blockmap`);
  const releaseDate = readField(previous, 'releaseDate') ?? new Date().toISOString();
  const next = formatUpdateInfo({ version, url, sha512, size, releaseDate });
  fs.writeFileSync(ymlFile, next);
  return { version, url, sha512, size, changed: next !== previous };
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: node scripts/metadonnees-maj.js <installer.exe>');
    process.exit(1);
  }
  refreshUpdateInfo(path.resolve(file))
    .then((info) => console.log(`latest.yml ${info.changed ? 'updated' : 'unchanged'}: ${info.url}, ${info.size} bytes`))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}

module.exports = { refreshUpdateInfo, formatUpdateInfo, readField };
