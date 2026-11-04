'use strict';

// Loaders de mods : Fabric, Quilt, Forge, NeoForge.
// Chacun produit un fichier de version qui « hérite » (inheritsFrom) de la version vanilla,
// exactement comme avec le launcher officiel.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { downloadAll, downloadFile, fetchBuffer, fetchJson } = require('./download');
const { mavenPath } = require('./rules');
const { exists, readJson, writeJson } = require('./store');
const { versionFiles } = require('./versions');
const zip = require('./zip');

const LOADERS = ['fabric', 'quilt', 'forge', 'neoforge'];
const LOADER_NAMES = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged';
const MARKER = '.0rzxn-loader';
const CACHE_MS = 30 * 60 * 1000;

// ---------- Listes de versions ----------

const cache = new Map();
async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Renvoie null si le service répond « version inconnue » (400/404), au lieu de lever une erreur. */
async function jsonOrNull(url) {
  try {
    return await fetchJson(url);
  } catch (error) {
    if (/Réponse (400|404)/.test(error.message)) return null;
    throw error;
  }
}

const isStable = (v) => !/(alpha|beta|rc|pre)/i.test(v);

function result(versions, recommended) {
  return { versions, recommended: recommended ?? versions.find((v) => v.stable)?.id ?? versions[0]?.id ?? null };
}

async function fabricLike(base, mc) {
  const data = await jsonOrNull(`${base}/versions/loader/${encodeURIComponent(mc)}`);
  if (!Array.isArray(data)) return result([]);
  return result(data.map((d) => ({ id: d.loader.version, stable: d.loader.stable ?? isStable(d.loader.version) })));
}

async function forgeVersions(mc) {
  const [xml, promos] = await Promise.all([
    cached('forge-maven', async () => (await fetchBuffer(`${FORGE_MAVEN}/maven-metadata.xml`)).toString('utf8')),
    cached('forge-promos', () => fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')),
  ]);
  const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
  const ids = all.filter((v) => v.startsWith(`${mc}-`)).reverse();
  const label = (id) => id.slice(mc.length + 1).replace(new RegExp(`-${mc.replace(/\./g, '\\.')}$`), '');
  const findPromo = (kind) => {
    const promo = promos.promos?.[`${mc}-${kind}`];
    return promo ? ids.find((id) => label(id) === promo) : undefined;
  };
  const recommended = findPromo('recommended') ?? findPromo('latest');
  return result(ids.map((id) => ({ id, label: label(id), stable: true })), recommended);
}

/** NeoForge numérote ses versions d'après Minecraft : 1.21.11 → 21.11.x, 26.3 → 26.3.0.x ; 1.20.1 utilise l'ancien artefact « forge ». */
async function neoforgeVersions(mc) {
  if (mc === '1.20.1') {
    const data = await cached('neoforge-legacy', () => fetchJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/forge'));
    const ids = data.versions.filter((v) => v.startsWith('1.20.1-')).reverse();
    return result(ids.map((id) => ({ id, label: id.slice(7), stable: isStable(id) })));
  }
  let prefix;
  const legacy = mc.match(/^1\.(\d+)(?:\.(\d+))?$/);
  if (legacy) prefix = `${legacy[1]}.${legacy[2] ?? 0}.`;
  else if (/^\d+\.\d+$/.test(mc)) prefix = `${mc}.0.`;
  else if (/^\d+\.\d+\.\d+$/.test(mc)) prefix = `${mc}.`;
  else return result([]);
  const data = await cached('neoforge', () => fetchJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge'));
  const ids = data.versions.filter((v) => v.startsWith(prefix) && v.slice(prefix.length).split('.').length <= 2).reverse();
  return result(ids.map((id) => ({ id, stable: isStable(id) })));
}

/** Versions disponibles pour chaque loader et une version de Minecraft (un loader en panne n'empêche pas les autres). */
async function availableLoaders(mc) {
  const load = {
    fabric: () => fabricLike('https://meta.fabricmc.net/v2', mc),
    quilt: () => fabricLike('https://meta.quiltmc.org/v3', mc),
    forge: () => forgeVersions(mc),
    neoforge: () => neoforgeVersions(mc),
  };
  const out = {};
  await Promise.all(
    LOADERS.map(async (loader) => {
      try {
        out[loader] = await cached(`${loader}:${mc}`, load[loader]);
      } catch (error) {
        out[loader] = { versions: [], recommended: null, error: error.message };
      }
    }),
  );
  return out;
}

/**
 * Format .mrpack ↔ format du launcher. Les modpacks écrivent « forge: 47.4.22 »,
 * le launcher range Forge sous « 1.20.1-47.4.22 » (identifiant Maven complet).
 */
async function resolveLoaderVersion(loader, mc, packValue) {
  if (loader === 'forge') {
    const { versions } = await forgeVersions(mc);
    const match = versions.find((v) => v.label === packValue || v.id === packValue);
    if (!match) throw new Error(`Forge ${packValue} introuvable pour Minecraft ${mc}.`);
    return match.id;
  }
  if (loader === 'neoforge' && mc === '1.20.1' && !packValue.startsWith('1.20.1-')) return `1.20.1-${packValue}`;
  return packValue;
}

/** Inverse de resolveLoaderVersion, pour l'export. */
function packLoaderVersion(loader, mc, launcherValue) {
  if (loader === 'forge' || (loader === 'neoforge' && mc === '1.20.1')) {
    return launcherValue.replace(new RegExp(`^${mc.replace(/\./g, '\\.')}-`), '').replace(new RegExp(`-${mc.replace(/\./g, '\\.')}$`), '');
  }
  return launcherValue;
}

// ---------- Installation ----------

/**
 * Installe le loader et renvoie l'identifiant de version à lancer (ex. « fabric-loader-0.20.1-26.3 »).
 * ctx : { dirs, mc, loader, loaderVersion, javaExe, signal, onProgress, log }
 */
async function installLoader(ctx) {
  if (ctx.loader === 'fabric') return installFabricLike(ctx, 'https://meta.fabricmc.net/v2');
  if (ctx.loader === 'quilt') return installFabricLike(ctx, 'https://meta.quiltmc.org/v3');
  if (ctx.loader === 'forge' || ctx.loader === 'neoforge') return installFromInstaller(ctx);
  throw new Error(`Loader inconnu : ${ctx.loader}`);
}

async function installFabricLike({ dirs, mc, loaderVersion, log }, base) {
  const url = `${base}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loaderVersion)}/profile/json`;
  const known = readJson(path.join(dirs.cache, 'loaders.json'), {})[url];
  if (known && exists(versionFiles(dirs, known).json)) return known;
  const profile = await fetchJson(url);
  writeJson(versionFiles(dirs, profile.id).json, profile);
  rememberId(dirs, url, profile.id);
  log(`Profil ${profile.id} installé`);
  return profile.id;
}

function rememberId(dirs, key, id) {
  const file = path.join(dirs.cache, 'loaders.json');
  writeJson(file, { ...readJson(file, {}), [key]: id });
}

function installerUrl(loader, version) {
  if (loader === 'forge') return `${FORGE_MAVEN}/${version}/forge-${version}-installer.jar`;
  if (version.startsWith('1.20.1-')) return `${NEOFORGE_MAVEN}/forge/${version}/forge-${version}-installer.jar`;
  return `${NEOFORGE_MAVEN}/neoforge/${version}/neoforge-${version}-installer.jar`;
}

async function installFromInstaller(ctx) {
  const { dirs, loader, loaderVersion, signal, log } = ctx;
  const url = installerUrl(loader, loaderVersion);
  const known = readJson(path.join(dirs.cache, 'loaders.json'), {})[url];
  if (known && exists(path.join(dirs.versions, known, MARKER)) && exists(versionFiles(dirs, known).json)) return known;

  log(`Téléchargement de l'installeur ${LOADER_NAMES[loader]} ${loaderVersion}`);
  const installer = path.join(dirs.cache, 'installers', path.basename(new URL(url).pathname));
  let sha1;
  try {
    sha1 = (await fetchBuffer(`${url}.sha1`, { signal })).toString('utf8').trim().slice(0, 40);
  } catch {
    sha1 = undefined; // certains anciens installeurs n'ont pas d'empreinte publiée
  }
  await downloadFile({ url, path: installer, sha1: /^[0-9a-f]{40}$/.test(sha1 ?? '') ? sha1 : undefined }, { signal });

  const buffer = await fsp.readFile(installer);
  const entries = zip.listEntries(buffer);
  const profile = JSON.parse(zip.readFile(buffer, 'install_profile.json', entries)?.toString('utf8') ?? 'null');
  if (!profile) throw new Error("Installeur invalide : install_profile.json introuvable.");

  const id = profile.versionInfo
    ? await installLegacyForge(ctx, profile, buffer, entries)
    : await installModern(ctx, profile, buffer, entries, installer);
  fs.writeFileSync(path.join(dirs.versions, id, MARKER), url);
  rememberId(dirs, url, id);
  log(`${LOADER_NAMES[loader]} ${loaderVersion} installé (${id})`);
  return id;
}

/** Forge 1.5 → 1.12 (ancien format) : le fichier de version est dans install_profile.json. */
async function installLegacyForge({ dirs }, profile, buffer, entries) {
  const json = structuredClone(profile.versionInfo);
  const universal = path.join(dirs.libraries, mavenPath(profile.install.path));
  if (!exists(universal)) {
    const data = zip.readFile(buffer, profile.install.filePath, entries);
    if (!data) throw new Error('Installeur Forge incomplet (jar universel manquant).');
    await fsp.mkdir(path.dirname(universal), { recursive: true });
    await fsp.writeFile(universal, data);
  }
  json.libraries = json.libraries
    .filter((lib) => lib.clientreq !== false) // marquées « serveur uniquement »
    .map(({ checksums, clientreq, serverreq, ...lib }) => ({
      ...lib,
      url: lib.url?.replace(/^https?:\/\/files\.minecraftforge\.net\/maven\/?/, 'https://maven.minecraftforge.net/'),
    }));
  writeJson(versionFiles(dirs, json.id).json, json);
  return json.id;
}

/** Forge 1.13+ (et 1.12.2 récent) et NeoForge : bibliothèques + processeurs Java. */
async function installModern(ctx, profile, buffer, entries, installerPath) {
  const { dirs, mc, javaExe, signal, onProgress, log } = ctx;
  const versionJson = JSON.parse(zip.readFile(buffer, profile.json.replace(/^\//, ''), entries).toString('utf8'));
  const id = versionJson.id;
  writeJson(versionFiles(dirs, id).json, versionJson);

  // Bibliothèques : téléchargées, ou fournies dans le dossier maven/ de l'installeur.
  const libraries = [...(profile.libraries ?? []), ...(versionJson.libraries ?? [])];
  const tasks = [];
  for (const lib of libraries) {
    const artifact = lib.downloads?.artifact;
    const rel = artifact?.path ?? mavenPath(lib.name);
    const target = path.join(dirs.libraries, rel);
    if (artifact?.url) {
      tasks.push({ url: artifact.url, path: target, sha1: artifact.sha1, size: artifact.size });
    } else if (!exists(target)) {
      const data = zip.readFile(buffer, `maven/${rel}`, entries);
      if (data) {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, data);
      }
      // sinon : fichier produit par un processeur (ex. le jeu patché)
    }
  }
  await downloadAll(tasks, { signal, onProgress });

  // Variables des processeurs
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), '0rzxn-loader-'));
  try {
    const libPath = (coords) => path.join(dirs.libraries, mavenPath(coords));
    const data = {
      SIDE: 'client',
      MINECRAFT_JAR: versionFiles(dirs, mc).jar,
      MINECRAFT_VERSION: mc,
      ROOT: dirs.root,
      INSTALLER: installerPath,
      LIBRARY_DIR: dirs.libraries,
    };
    for (const [key, value] of Object.entries(profile.data ?? {})) {
      const raw = value.client;
      if (raw == null) continue;
      if (/^\[.+\]$/.test(raw)) data[key] = libPath(raw.slice(1, -1));
      else if (/^'.*'$/.test(raw)) data[key] = raw.slice(1, -1);
      else if (raw.startsWith('/')) {
        const file = path.join(work, raw.slice(1));
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, zip.readFile(buffer, raw.slice(1), entries));
        data[key] = file;
      } else data[key] = raw;
    }
    const resolve = (text) => {
      if (/^\[.+\]$/.test(text)) return libPath(text.slice(1, -1));
      const replaced = text.replace(/\{(\w+)\}/g, (whole, key) => (key in data ? data[key] : whole));
      return /^'.*'$/.test(replaced) ? replaced.slice(1, -1) : replaced;
    };

    const processors = (profile.processors ?? []).filter((p) => !p.sides || p.sides.includes('client'));
    for (const [index, processor] of processors.entries()) {
      signal?.throwIfAborted();
      const outputs = Object.entries(processor.outputs ?? {}).map(([file, hash]) => [resolve(file), resolve(hash)]);
      if (outputs.length && (await Promise.all(outputs.map(([file, hash]) => sameSha1(file, hash)))).every(Boolean)) continue;

      const jar = libPath(processor.jar);
      const mainClass = mainClassOf(await fsp.readFile(jar));
      const classpath = [jar, ...(processor.classpath ?? []).map(libPath)].join(path.delimiter);
      const args = processor.args.map(resolve);
      log(`Processeur ${index + 1}/${processors.length} : ${processor.jar.split(':')[1]}`);
      await runJava(javaExe, ['-cp', classpath, mainClass, ...args], { cwd: work, signal, log });

      for (const [file, hash] of outputs) {
        if (!(await sameSha1(file, hash))) throw new Error(`Le processeur ${processor.jar} a produit un fichier inattendu : ${path.basename(file)}`);
      }
    }
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
  return id;
}

async function sameSha1(file, expected) {
  try {
    const data = await fsp.readFile(file);
    return crypto.createHash('sha1').update(data).digest('hex') === expected;
  } catch {
    return false;
  }
}

function mainClassOf(jarBuffer) {
  const manifest = zip.readFile(jarBuffer, 'META-INF/MANIFEST.MF')?.toString('utf8') ?? '';
  const main = manifest.match(/^Main-Class:\s*(.+)$/m)?.[1]?.trim();
  if (!main) throw new Error('Processeur sans classe principale.');
  return main;
}

function runJava(javaExe, args, { cwd, signal, log }) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaExe, args, { cwd, windowsHide: true });
    const tail = [];
    const keep = (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 30) tail.shift();
      }
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (error) => reject(new Error(`Java ne démarre pas pour l'installation du loader (${error.message}).`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(new Error('Installation annulée.'));
      if (code === 0) return resolve();
      for (const line of tail.slice(-10)) log(line, 'LAUNCHER/ERROR');
      reject(new Error(`L'installation du loader a échoué (code ${code}). Détails dans la console.`));
    });
  });
}

module.exports = { LOADERS, LOADER_NAMES, availableLoaders, installLoader, resolveLoaderVersion, packLoaderVersion };
