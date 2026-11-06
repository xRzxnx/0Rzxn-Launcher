'use strict';

// Java automatique : runtimes officiels de Mojang (les mêmes que le launcher officiel).
const { t } = require('../i18n');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { downloadAll, fetchBuffer, fetchJson, sha1 } = require('./download');
const { exists } = require('./store');

const RUNTIME_INDEX_URL =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const MARKER = '.0rzxn-manifest';

function platformKey() {
  const { platform, arch } = process;
  if (platform === 'win32') return arch === 'arm64' ? 'windows-arm64' : arch === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return arch === 'ia32' ? 'linux-i386' : 'linux';
}

/** Exécutable Java d'un runtime Mojang. Sous Windows, java.exe (et non javaw) pour lire les logs. */
function runtimeExecutable(dir) {
  if (process.platform === 'win32') return path.join(dir, 'bin', 'java.exe');
  if (process.platform === 'darwin') return path.join(dir, 'jre.bundle', 'Contents', 'Home', 'bin', 'java');
  return path.join(dir, 'bin', 'java');
}

/**
 * Installe (si besoin) le runtime `component` (ex. java-runtime-epsilon) et renvoie le chemin de Java.
 * Hors connexion, un runtime déjà installé est réutilisé.
 */
async function ensureRuntime(dirs, component, { signal, onProgress } = {}) {
  const dir = path.join(dirs.runtime, component);
  const exe = runtimeExecutable(dir);
  const marker = path.join(dir, MARKER);
  const installed = exists(exe) && exists(marker);

  let entry;
  try {
    entry = (await fetchJson(RUNTIME_INDEX_URL, { signal }))[platformKey()]?.[component]?.[0];
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

/** Lance `java -version` et renvoie la version majeure (8, 17, 21, 25…). */
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
      resolve({ major: first === 1 ? Number(match[2]) : first, description: output.split(/\r?\n/)[0].trim() });
    });
  });
}

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

const VENDOR_DIRS = ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'AdoptOpenJDK', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru', 'OpenJDK'];

/** Chemins où chercher un Java installé sur le PC (lecture seule). */
function systemJavaCandidates(env = process.env) {
  const exeName = process.platform === 'win32' ? 'java.exe' : 'java';
  const found = [];
  const subdirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
    } catch {
      return [];
    }
  };
  if (process.platform === 'win32') {
    const roots = [...new Set([env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean))];
    for (const root of roots) for (const vendor of VENDOR_DIRS) for (const dir of subdirs(path.join(root, vendor))) found.push(path.join(dir, 'bin', exeName));
  } else if (process.platform === 'darwin') {
    for (const dir of subdirs('/Library/Java/JavaVirtualMachines')) found.push(path.join(dir, 'Contents', 'Home', 'bin', exeName));
  } else {
    for (const dir of subdirs('/usr/lib/jvm')) found.push(path.join(dir, 'bin', exeName));
  }
  if (env.JAVA_HOME) found.push(path.join(env.JAVA_HOME, 'bin', exeName));
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) found.push(path.join(dir, exeName));
  return found;
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
    const key = real.toLowerCase();
    if (seen.has(key) || key.startsWith(dirs.root.toLowerCase() + path.sep)) continue;
    seen.add(key);
    paths.push(file);
  }
  const probed = await Promise.all(paths.map((file) => probeJava(file).then((info) => ({ path: file, ...info }), () => null)));
  const versions = new Set();
  return probed.filter((java) => {
    if (!java || versions.has(java.description)) return false;
    versions.add(java.description);
    return true;
  }).map((java) => {
    const dir = path.dirname(java.path);
    const folder = path.basename(dir).toLowerCase() === 'bin' ? path.basename(path.dirname(dir)) : path.basename(dir);
    return { path: java.path, major: java.major, description: java.description, name: !folder || /^java\d*path/i.test(folder) ? `Java ${java.major}` : folder };
  });
}

module.exports = { ensureRuntime, probeJava, runtimeExecutable, listRuntimes, findSystemJavas, majorOf };
