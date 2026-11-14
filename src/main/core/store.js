'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Lit un fichier JSON ; renvoie `fallback` s'il n'existe pas ou est illisible. */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Écrit un fichier JSON de façon atomique (fichier temporaire puis renommage). */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Dossiers partagés du launcher, sous la racine choisie (par défaut %APPDATA%\.0rzxn, voir platform/chemins.js gameRoot).
 * La racine est convertie en chemin physique : si le dossier est redirigé (lien, jonction,
 * virtualisation de Windows), Java et Fabric comparent des chemins identiques à ceux du launcher.
 */
function gameDirs(requestedRoot) {
  let root = requestedRoot;
  try {
    fs.mkdirSync(requestedRoot, { recursive: true });
    root = fs.realpathSync.native(requestedRoot);
  } catch {
    // on garde le chemin demandé
  }
  return {
    root,
    versions: path.join(root, 'versions'),
    libraries: path.join(root, 'libraries'),
    assets: path.join(root, 'assets'),
    runtime: path.join(root, 'runtime'),
    instances: path.join(root, 'instances'),
    cache: path.join(root, 'cache'),
    backups: path.join(root, 'backups'),
    skins: path.join(root, 'skins'),
  };
}

module.exports = { readJson, writeJson, exists, gameDirs };
