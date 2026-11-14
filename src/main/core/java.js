'use strict';

// Java automatique : runtimes officiels de Mojang (les mêmes que le launcher officiel).
const { t } = require('../i18n');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { downloadAll, fetchBuffer, fetchJson, sha1 } = require('./download');
const { exists } = require('./store');
const { javaSearchDirs } = require('../platform/chemins');

const RUNTIME_INDEX_URL =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const MARKER = '.0rzxn-manifest';

/** Clé de Mojang pour un système et un processeur (`arch` : celui du PC, ou x64 pour Rosetta). */
function platformKey(arch = process.arch, platform = process.platform) {
  if (platform === 'win32') return arch === 'arm64' ? 'windows-arm64' : arch === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return arch === 'ia32' ? 'linux-i386' : 'linux';
}

/**
 * La version a-t-elle des natives pour les Mac Apple Silicon ? Oui à partir de Minecraft 1.19 (LWJGL 3.3,
 * bibliothèques « …:natives-macos-arm64 ») ; avant, les natives n'existent qu'en Intel.
 */
function hasArm64MacNatives(version) {
  return (version.libraries ?? []).some(
    (lib) => /natives-macos-arm64/.test(lib.name ?? '') || Object.keys(lib.downloads?.classifiers ?? {}).some((key) => /natives-macos-arm64/.test(key)),
  );
}

/** Mac Apple Silicon et version sans natives arm64 : le jeu tourne avec un Java Intel, traduit par Rosetta. */
function needsRosetta(version, { platform = process.platform, arch = process.arch } = {}) {
  return platform === 'darwin' && arch === 'arm64' && !hasArm64MacNatives(version);
}

/** Rosetta 2 installé (Apple le place toujours ici). */
function rosettaInstalled(check = fs.existsSync) {
  return check('/Library/Apple/usr/share/rosetta/rosetta');
}

/** Exécutable Java d'un runtime Mojang. Sous Windows, java.exe (et non javaw) pour lire les logs. */
function runtimeExecutable(dir) {
  if (process.platform === 'win32') return path.join(dir, 'bin', 'java.exe');
  if (process.platform === 'darwin') return path.join(dir, 'jre.bundle', 'Contents', 'Home', 'bin', 'java');
  return path.join(dir, 'bin', 'java');
}

/**
 * Installe (si besoin) le runtime `component` (ex. java-runtime-epsilon) et renvoie le chemin de Java.
 * Hors connexion, un runtime déjà installé est réutilisé. `arch: 'x64'` sur un Mac Apple Silicon : version Intel
 * (Rosetta), rangée à part (« jre-legacy-x64 ») pour ne pas écraser la version arm64 du même runtime.
 * @param {any} dirs
 * @param {string} component
 * @param {{ signal?: AbortSignal, onProgress?: (p: any) => void, arch?: string }} [options]
 */
async function ensureRuntime(dirs, component, { signal, onProgress, arch = process.arch } = {}) {
  const dir = path.join(dirs.runtime, arch === process.arch ? component : `${component}-${arch}`);
  const exe = runtimeExecutable(dir);
  const marker = path.join(dir, MARKER);
  const installed = exists(exe) && exists(marker);

  let entry;
  try {
    entry = (await fetchJson(RUNTIME_INDEX_URL, { signal }))[platformKey(arch)]?.[component]?.[0];
  } catch (error) {
    if (installed) return exe;
    throw new Error(t('java.java_est_pas_encore_installe', { component, message: error.message }));
  }
  if (!entry) {
    if (installed) return exe;
    throw new Error(t('java.mojang_ne_fournit_pas_pour', { component }));
  }
  if (installed && fs.readFileSync(marker, 'utf8').trim() === entry.manifest.sha1) return exe;

  const raw = await fetchBuffer(entry.manifest.url, { signal });
  if (sha1(raw) !== entry.manifest.sha1) throw new Error(t('java.le_manifeste_de_java_telecharge'));
  const { files } = JSON.parse(raw.toString('utf8'));

  const tasks = [];
  const links = [];
  for (const [name, file] of Object.entries(files)) {
    const target = path.join(dir, name);
    if (file.type === 'directory') await fsp.mkdir(target, { recursive: true });
    else if (file.type === 'file' && file.downloads?.raw) {
      tasks.push({ url: file.downloads.raw.url, path: target, sha1: file.downloads.raw.sha1, size: file.downloads.raw.size, executable: file.executable });
    } else if (file.type === 'link') links.push({ target, to: file.target });
  }
  await downloadAll(tasks, { signal, onProgress });

  if (process.platform !== 'win32') {
    for (const task of tasks) if (task.executable) await fsp.chmod(task.path, 0o755);
    for (const link of links) {
      await fsp.rm(link.target, { force: true });
      await fsp.symlink(link.to, link.target);
    }
  }
  fs.writeFileSync(marker, entry.manifest.sha1);
  return exe;
}

/**
 * 64 ou 32 bits d'après `java -version` : les Java 64 bits l'écrivent (« 64-Bit Server VM », « amd64-64-Bit »), les
 * 32 bits non (« Client VM », « Server VM » seuls). null si la sortie ne permet pas de le dire.
 * @param {string} output
 */
function javaBits(output) {
  if (/64-Bit/i.test(output)) return 64;
  if (/(Client|Server) VM/.test(output)) return 32;
  return null;
}

/** Lance `java -version` et renvoie la version majeure (8, 17, 21, 25…) et 32 ou 64 bits. */
function probeJava(exe) {
  return new Promise((resolve, reject) => {
    let output = '';
    let child;
    try {
      child = spawn(exe, ['-version'], { windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(t('java.java_ne_demarre_pas', { code: error.code ?? error.message, exe })));
    });
    child.on('close', () => {
      clearTimeout(timer);
      const match = output.match(/version "(\d+)(?:\.(\d+))?/);
      if (!match) return reject(new Error(t('java.version_de_java_illisible', { exe })));
      const first = Number(match[1]);
      resolve({ major: first === 1 ? Number(match[2]) : first, description: output.split(/\r?\n/)[0].trim(), bits: javaBits(output) });
    });
  });
}

// Résultats de `java -version` gardés par chemin, tant que le fichier ne change pas (taille, date).
const probed = new Map();

/** Comme probeJava, sans relancer Java si ce fichier a déjà été vérifié. @param {string} exe */
async function probeJavaCached(exe) {
  let stat = null;
  try {
    stat = fs.statSync(exe);
  } catch {
    // fichier absent : probeJava donnera le bon message
  }
  const key = stat ? `${stat.size}:${stat.mtimeMs}` : null;
  const hit = probed.get(exe);
  if (key && hit?.key === key) return hit.info;
  const info = await probeJava(exe);
  if (key) probed.set(exe, { key, info });
  return info;
}

/** Mémoire au plus d'un Java 32 bits, en Go (l'espace d'adresses limite le tas à environ 1,5 Go sous Windows). */
const JAVA_32_MAX_GB = 1.5;

/** « 1.8.0_51 » → 8, « 21.0.7 » → 21. */
function majorOf(version) {
  const [first, second] = String(version).split(/[._+-]/).map(Number);
  return first === 1 ? second : first;
}

/** Runtimes Mojang téléchargés par le launcher (dossier runtime) : composant, version et chemin. */
function listRuntimes(dirs) {
  let names = [];
  try {
    names = fs.readdirSync(dirs.runtime, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return names.map((component) => {
    const dir = path.join(dirs.runtime, component);
    let version = null;
    try {
      version = fs.readFileSync(path.join(dir, 'release'), 'utf8').match(/^JAVA_VERSION="([^"]+)"/m)?.[1] ?? null;
    } catch {
      // pas de fichier release : version inconnue
    }
    return { component, dir, version, major: version ? majorOf(version) : null, complete: exists(runtimeExecutable(dir)) && exists(path.join(dir, MARKER)) };
  });
}

/**
 * Chemins où chercher un Java installé sur le PC (lecture seule) : dossiers connus du système (platform/chemins.js),
 * JAVA_HOME puis PATH. `readdir` est remplaçable pour les tests.
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, home?: string, readdir?: (dir: string) => import('node:fs').Dirent[] }} [ctx]
 */
function systemJavaCandidates(ctx = {}) {
  const platform = ctx.platform ?? process.platform;
  const env = ctx.env ?? process.env;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const readdir = ctx.readdir ?? ((dir) => fs.readdirSync(dir, { withFileTypes: true }));
  const exeName = platform === 'win32' ? 'java.exe' : 'java';
  const found = [];
  const subdirs = (dir, prefix = '') => {
    try {
      return readdir(dir).filter((d) => d.isDirectory() && d.name.startsWith(prefix)).map((d) => p.join(dir, d.name));
    } catch {
      return [];
    }
  };
  for (const { parent, prefix, home } of javaSearchDirs({ platform, env, home: ctx.home })) {
    for (const dir of subdirs(parent, prefix)) found.push(p.join(dir, ...home, 'bin', exeName));
  }
  if (env.JAVA_HOME) found.push(p.join(env.JAVA_HOME, 'bin', exeName));
  const separator = platform === 'win32' ? ';' : ':';
  for (const dir of (env.PATH ?? env.Path ?? '').split(separator).filter(Boolean)) found.push(p.join(dir, exeName));
  return found;
}

/**
 * Nom affiché d'un Java du PC : son dossier (« jdk-21 »). Sur macOS le dossier de `bin` s'appelle « Home » :
 * on remonte au paquet (« temurin-21.jdk » → « temurin-21 », Homebrew « openjdk@21 »).
 * @param {string} javaPath
 */
function javaFolderName(javaPath) {
  const parts = javaPath.split(/[\\/]+/).filter(Boolean);
  parts.pop(); // java ou java.exe
  if (parts.at(-1)?.toLowerCase() === 'bin') parts.pop();
  if (parts.at(-1) === 'Home' && parts.at(-2) === 'Contents') {
    parts.splice(-2);
    if (parts.at(-1) === 'openjdk.jdk' && parts.at(-2) === 'libexec') parts.splice(-2);
  }
  return (parts.at(-1) ?? '').replace(/\.jdk$/, '');
}

/**
 * Java installés sur le PC, hors runtimes du launcher : un seul par version exacte
 * (le raccourci « java8path » d'Oracle et le vrai dossier sont la même installation).
 */
async function findSystemJavas(dirs) {
  const seen = new Set();
  const paths = [];
  for (const file of systemJavaCandidates()) {
    let real;
    try {
      real = fs.realpathSync.native(file);
    } catch {
      continue;
    }
    // Windows et macOS ignorent la casse des noms de fichiers, Linux non.
    const fold = (/** @type {string} */ s) => (process.platform === 'linux' ? s : s.toLowerCase());
    const key = fold(real);
    if (seen.has(key) || key.startsWith(fold(dirs.root) + path.sep)) continue;
    seen.add(key);
    paths.push(file);
  }
  const found = await Promise.all(paths.map((file) => probeJavaCached(file).then((info) => ({ path: file, ...info }), () => null)));
  const versions = new Set();
  return found.filter((java) => {
    if (!java || versions.has(java.description)) return false;
    versions.add(java.description);
    return true;
  }).map((java) => {
    const folder = javaFolderName(java.path);
    return { path: java.path, major: java.major, bits: java.bits, description: java.description, name: !folder || /^java\d*path/i.test(folder) ? `Java ${java.major}` : folder };
  });
}

module.exports = { ensureRuntime, platformKey, hasArm64MacNatives, needsRosetta, rosettaInstalled, probeJava, probeJavaCached, javaBits, JAVA_32_MAX_GB, runtimeExecutable, listRuntimes, findSystemJavas, systemJavaCandidates, javaFolderName, majorOf };
