// @ts-check
'use strict';

// Dossiers qui dépendent du système : dossier du jeu, dossiers de l'autre launcher compatible, Java installés.
// Fonctions pures : le système, le dossier personnel et les variables d'environnement se passent en paramètres
// (les tests simulent macOS et Linux sous Windows), avec les valeurs du PC par défaut.
const os = require('node:os');
const path = require('node:path');

/**
 * @typedef {{ platform?: string, home?: string, env?: NodeJS.ProcessEnv, appData?: string }} Contexte
 * `appData` : `app.getPath('appData')` d'Electron (%APPDATA%, ~/Library/Application Support, ~/.config).
 */

/** @param {Contexte} [ctx] */
function contexte(ctx = {}) {
  const platform = ctx.platform ?? process.platform;
  const env = ctx.env ?? process.env;
  const home = ctx.home ?? os.homedir();
  const p = platform === 'win32' ? path.win32 : path.posix;
  return { platform, env, home, p, appData: ctx.appData ?? '' };
}

/** Données d'application sous Linux (règle XDG) : $XDG_DATA_HOME, sinon ~/.local/share. */
function xdgData({ env, home, p }) {
  return env.XDG_DATA_HOME && p.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : p.join(home, '.local', 'share');
}

/**
 * Dossier du jeu (versions, bibliothèques, Java, instances) :
 * Windows %APPDATA%\.0rzxn, macOS ~/Library/Application Support/.0rzxn, Linux ~/.local/share/0rzxn.
 * @param {Contexte} [ctx]
 */
function gameRoot(ctx) {
  const c = contexte(ctx);
  if (c.platform === 'win32' || c.platform === 'darwin') return c.p.join(c.appData, '.0rzxn');
  return c.p.join(xdgData(c), '0rzxn');
}

/**
 * Dossiers de données possibles du launcher compatible le plus courant, du plus probable au moins probable.
 * Les noms sont ceux de ses dossiers sur le disque, nécessaires pour le trouver (Flatpak compris sous Linux).
 * @param {Contexte} [ctx]
 */
function importRoots(ctx) {
  const c = contexte(ctx);
  if (c.platform === 'win32' || c.platform === 'darwin') return [c.p.join(c.appData, 'PrismLauncher')];
  return [
    c.p.join(xdgData(c), 'PrismLauncher'),
    c.p.join(c.home, '.var', 'app', 'org.prismlauncher.PrismLauncher', 'data', 'PrismLauncher'),
  ];
}

const VENDOR_DIRS = ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'AdoptOpenJDK', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru', 'OpenJDK'];

/**
 * Où chercher les Java installés. Chaque entrée : un dossier `parent` dont chaque sous-dossier (filtré par `prefix`)
 * contient un Java dans `home` (chemin relatif du dossier « home » du JDK). `bin/java` est ajouté par l'appelant.
 * @param {Contexte} [ctx]
 * @returns {{ parent: string, prefix?: string, home: string[] }[]}
 */
function javaSearchDirs(ctx) {
  const c = contexte(ctx);
  const ide = { parent: c.p.join(c.home, '.jdks'), home: [] }; // Java téléchargés par les IDE de JetBrains
  if (c.platform === 'win32') {
    /** @type {Set<string>} */
    const roots = new Set();
    for (const root of [c.env.ProgramFiles, c.env['ProgramFiles(x86)'], c.env.ProgramW6432]) if (root) roots.add(root);
    return [...[...roots].flatMap((root) => VENDOR_DIRS.map((vendor) => ({ parent: c.p.join(root, vendor), home: [] }))), ide];
  }
  if (c.platform === 'darwin') {
    const bundle = ['Contents', 'Home'];
    const brew = ['libexec', 'openjdk.jdk', 'Contents', 'Home'];
    return [
      { parent: '/Library/Java/JavaVirtualMachines', home: bundle },
      { parent: c.p.join(c.home, 'Library', 'Java', 'JavaVirtualMachines'), home: bundle },
      { parent: '/opt/homebrew/opt', prefix: 'openjdk', home: brew }, // Homebrew, Mac Apple Silicon
      { parent: '/usr/local/opt', prefix: 'openjdk', home: brew }, // Homebrew, Mac Intel
      { ...ide, home: bundle },
    ];
  }
  return [
    { parent: '/usr/lib/jvm', home: [] },
    { parent: c.p.join(c.home, '.sdkman', 'candidates', 'java'), home: [] },
    ide,
  ];
}

module.exports = { gameRoot, importRoots, javaSearchDirs, VENDOR_DIRS };
