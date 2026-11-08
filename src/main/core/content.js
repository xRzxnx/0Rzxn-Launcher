'use strict';

// Contenu d'une instance : mods, packs de ressources et shaders. Fichiers locaux + Modrinth.
const { compareText, t } = require('../i18n');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { downloadFile } = require('./download');
const modrinth = require('./modrinth');
const zip = require('./zip');

const KINDS = {
  mods: { folder: 'mods', projectType: 'mod', extension: '.jar' },
  resourcepacks: { folder: 'resourcepacks', projectType: 'resourcepack', extension: '.zip', folders: true },
  shaders: { folder: 'shaderpacks', projectType: 'shader', extension: '.zip', folders: true },
};
const DISABLED = '.disabled';
const MAX_ICON = 300 * 1024;

function kindInfo(kind) {
  const info = KINDS[kind];
  if (!info) throw new Error(t('content.type_de_contenu_inconnu'));
  return info;
}

/** Loaders Modrinth compatibles avec l'instance pour ce type de contenu. */
function loadersFor(kind, instance) {
  if (kind === 'resourcepacks') return ['minecraft'];
  if (kind === 'shaders') return ['iris', 'optifine'];
  if (!instance.loader || instance.loader === 'vanilla') return [];
  return instance.loader === 'quilt' ? ['quilt', 'fabric'] : [instance.loader];
}

function contentDir(gameDir, kind) {
  return path.join(gameDir, kindInfo(kind).folder);
}

/** Nom de fichier sûr, présent dans le dossier (pas de « ../ »). */
function safePath(dir, name) {
  if (typeof name !== 'string' || !name || path.basename(name) !== name) throw new Error(t('content.nom_de_fichier_invalide'));
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) throw new Error(t('content.fichier_introuvable'));
  return file;
}

// ---------- Lecture des métadonnées ----------

function asText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(asText).join('');
  if (value && typeof value === 'object') return asText(value.text ?? '') + asText(value.extra ?? '');
  return '';
}

function iconData(buffer, entries, iconPath) {
  if (!iconPath) return null;
  const data = zip.readFile(buffer, iconPath.replace(/^\//, ''), entries);
  if (!data || data.length > MAX_ICON) return null;
  const type = iconPath.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/png';
  return `data:${type};base64,${data.toString('base64')}`;
}

function tomlValue(text, key) {
  return text.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"'\\n]*)["']`, 'm'))?.[1];
}

/** Nom, version, description et icône lus dans un jar de mod (Fabric, Quilt, Forge, NeoForge). */
function modMetadata(buffer, entries) {
  const json = (name) => {
    try {
      return JSON.parse(zip.readFile(buffer, name, entries)?.toString('utf8') ?? 'null');
    } catch {
      return null;
    }
  };
  const fabric = json('fabric.mod.json');
  if (fabric) {
    const icon = typeof fabric.icon === 'object' ? Object.entries(fabric.icon).sort((a, b) => b[0] - a[0])[0]?.[1] : fabric.icon;
    return { modId: fabric.id, name: fabric.name ?? fabric.id, version: fabric.version, description: fabric.description, icon: iconData(buffer, entries, icon) };
  }
  const quilt = json('quilt.mod.json')?.quilt_loader;
  if (quilt) {
    return { modId: quilt.id, name: quilt.metadata?.name ?? quilt.id, version: quilt.version, description: quilt.metadata?.description, icon: iconData(buffer, entries, quilt.metadata?.icon) };
  }
  const toml = (zip.readFile(buffer, 'META-INF/neoforge.mods.toml', entries) ?? zip.readFile(buffer, 'META-INF/mods.toml', entries))?.toString('utf8');
  if (toml) {
    const section = toml.slice(toml.indexOf('[[mods]]'));
    let version = tomlValue(section, 'version');
    if (version === '${file.jarVersion}') {
      const manifest = zip.readFile(buffer, 'META-INF/MANIFEST.MF', entries)?.toString('utf8') ?? '';
      version = manifest.match(/^Implementation-Version:\s*(.+)$/m)?.[1]?.trim() ?? version;
    }
    const logo = tomlValue(section, 'logoFile') ?? tomlValue(toml, 'logoFile');
    return { modId: tomlValue(section, 'modId'), name: tomlValue(section, 'displayName'), version, description: tomlValue(section, 'description'), icon: iconData(buffer, entries, logo) };
  }
  const mcmod = json('mcmod.info');
  const info = Array.isArray(mcmod) ? mcmod[0] : mcmod?.modList?.[0];
  if (info) return { modId: info.modid, name: info.name, version: info.version, description: info.description, icon: iconData(buffer, entries, info.logoFile) };
  return {};
}

function packMetadata(buffer, entries) {
  let description;
  try {
    description = asText(JSON.parse(zip.readFile(buffer, 'pack.mcmeta', entries)?.toString('utf8') ?? '{}').pack?.description);
  } catch {
    description = undefined;
  }
  return { description: description?.replace(/§./g, ''), icon: iconData(buffer, entries, 'pack.png') };
}

const cache = new Map(); // chemin → { mtimeMs, size, item }

async function readItem(dir, entry, kind) {
  const file = path.join(dir, entry.name);
  const stat = await fsp.stat(file);
  const enabled = !entry.name.endsWith(DISABLED);
  const base = { file: entry.name, enabled, size: stat.size, isFolder: entry.isDirectory() };
  const displayName = entry.name.replace(DISABLED, '').replace(/\.(jar|zip)$/i, '');
  if (entry.isDirectory()) return { ...base, name: displayName };

  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return { ...hit.item, ...base };

  const buffer = await fsp.readFile(file);
  const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
  let meta = {};
  try {
    const entries = zip.listEntries(buffer);
    meta = kind === 'mods' ? modMetadata(buffer, entries) : packMetadata(buffer, entries);
  } catch {
    meta = {}; // archive illisible : on garde le nom du fichier
  }
  const item = { ...base, sha1, name: meta.name || displayName, version: meta.version ?? null, description: meta.description ?? null, icon: meta.icon ?? null, modId: meta.modId ?? null };
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, item });
  return item;
}

/**
 * Liste le contenu installé. Avec `online`, chaque fichier est identifié sur Modrinth
 * (projet, icône) et comparé à la dernière version compatible.
 */
async function listContent({ gameDir, kind, instance, online = true }) {
  const info = kindInfo(kind);
  const dir = contentDir(gameDir, kind);
  await fsp.mkdir(dir, { recursive: true });
  const entries = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => {
    if (e.isDirectory()) return Boolean(info.folders);
    return e.isFile() && e.name.replace(DISABLED, '').toLowerCase().endsWith(info.extension);
  });
  const items = [];
  for (const entry of entries) {
    try {
      items.push(await readItem(dir, entry, kind));
    } catch {
      // fichier en cours d'écriture ou supprimé entre-temps
    }
  }

  let identified = false;
  if (online) {
    try {
      const hashes = items.map((i) => i.sha1).filter(Boolean);
      const known = await modrinth.versionsByHash(hashes);
      const projects = await modrinth.projects([...new Set(Object.values(known).map((v) => v.projectId))]);
      const projectById = Object.fromEntries(projects.map((p) => [p.id, p]));
      const latest = await modrinth.latestByHash(Object.keys(known), { loaders: loadersFor(kind, instance), gameVersion: instance.version });
      for (const item of items) {
        const v = item.sha1 && known[item.sha1];
        if (!v) continue;
        const p = projectById[v.projectId];
        Object.assign(item, { projectId: v.projectId, versionId: v.id, version: v.number, slug: p?.slug, title: p?.title ?? item.name, icon: p?.icon ?? item.icon, gameVersions: v.gameVersions ?? [] });
        const next = latest[item.sha1];
        // Une bêta n'est proposée qu'à qui utilise déjà une bêta.
        const sameChannel = next && (v.type !== 'release' || next.type === 'release');
        if (next && next.id !== v.id && next.file && sameChannel) item.update = { versionId: next.id, number: next.number };
      }
      identified = true;
    } catch {
      identified = false; // hors connexion : on affiche les infos locales
    }
  }

  items.sort((a, b) => compareText(a.title ?? a.name, b.title ?? b.name, { sensitivity: 'base' }));
  return { kind, folder: dir, online: identified, items };
}

/**
 * Avant de passer l'instance en `target` : pour chaque fichier actif, ce qui arrivera.
 * same : déjà prévu pour cette version ; update : une version compatible existe sur Modrinth ;
 * missing : rien pour cette version ; unknown : fichier inconnu de Modrinth (gardé tel quel).
 * `localMismatch` : fichiers (mods) dont le jar annonce une autre version de Minecraft.
 */
async function versionPlan({ gameDir, instance, target, localMismatch = new Set() }) {
  const plan = [];
  for (const kind of Object.keys(KINDS)) {
    const loaders = loadersFor(kind, instance);
    if (kind === 'mods' && loaders.length === 0) continue;
    const { items } = await listContent({ gameDir, kind, instance, online: false });
    const active = items.filter((i) => i.enabled && i.sha1);
    if (!active.length) continue;
    const known = await modrinth.versionsByHash(active.map((i) => i.sha1));
    const latest = await modrinth.latestByHash(Object.keys(known), { loaders, gameVersion: target });
    for (const item of active) {
      const v = known[item.sha1];
      let fate;
      if (!v) fate = kind === 'mods' && localMismatch.has(item.file) ? 'missing' : 'unknown';
      else if ((v.gameVersions ?? []).includes(target)) fate = 'same';
      else fate = latest[item.sha1]?.file ? 'update' : 'missing';
      plan.push({ kind, file: item.file, name: item.name, fate, number: fate === 'update' ? latest[item.sha1].number : null, known: Boolean(v) });
    }
  }
  return plan;
}

async function toggle({ gameDir, kind, file }) {
  const dir = contentDir(gameDir, kind);
  const source = safePath(dir, file);
  const target = file.endsWith(DISABLED) ? path.join(dir, file.slice(0, -DISABLED.length)) : `${source}${DISABLED}`;
  await fsp.rename(source, target);
}

/**
 * Installe un projet Modrinth (et, pour les mods, ses dépendances obligatoires).
 * Une ancienne version du même projet est envoyée à la corbeille via `trash(chemin)`.
 */
async function install({ gameDir, kind, instance, projectId, versionId = null, trash, log = () => {} }) {
  const info = kindInfo(kind);
  const dir = contentDir(gameDir, kind);
  const loaders = loadersFor(kind, instance);
  if (kind === 'mods' && loaders.length === 0) throw new Error(t('content.cette_instance_est_vanilla_ajoute'));

  const current = await listContent({ gameDir, kind, instance });
  const done = [];
  const skipped = [];
  const visited = new Set();

  async function installProject(pid, vid, dependency) {
    if (!pid && vid) pid = (await modrinth.version(vid)).projectId;
    if (!pid || visited.has(pid)) return;
    visited.add(pid);

    const existing = current.items.filter((i) => i.projectId === pid);
    if (dependency && existing.length) { // dépendance déjà présente, éventuellement à réactiver
      if (!existing.some((i) => i.enabled)) await toggle({ gameDir, kind, file: existing[0].file });
      return;
    }

    const v = vid ? await modrinth.version(vid) : modrinth.pickVersion(await modrinth.versions(pid, { loaders, gameVersion: instance.version }));
    if (!v?.file) {
      if (dependency) {
        skipped.push(pid);
        return;
      }
      throw Object.assign(new Error(t(loaders[0] && kind === 'mods' ? 'content.no_version_loader' : 'content.no_version', { version: instance.version, loader: instance.loader })), { code: 'NO_VERSION' });
    }
    if (!existing.some((i) => i.versionId === v.id)) {
      const filename = path.basename(v.file.filename);
      if (!filename.toLowerCase().endsWith(info.extension)) throw new Error(t('content.fichier_inattendu', { filename }));
      await downloadFile({ url: v.file.url, path: path.join(dir, filename), sha1: v.file.sha1, size: v.file.size });
      for (const old of existing) {
        if (old.file !== filename) await trash(path.join(dir, old.file));
      }
      done.push({ projectId: pid, version: v.number, file: filename, dependency });
      log(t('content.installe', { filename }));
    }

    if (kind === 'mods') {
      for (const dep of v.dependencies.filter((d) => d.dependency_type === 'required')) {
        if (dep.project_id || dep.version_id) await installProject(dep.project_id, dep.version_id, true);
        else skipped.push(dep.file_name ?? pid); // fichier hors de Modrinth
      }
    }
  }

  await installProject(projectId, versionId, false);
  const titles = await modrinth.projects(done.map((d) => d.projectId)).catch(() => []);
  const titleOf = Object.fromEntries(titles.map((p) => [p.id, p.title]));
  return {
    installed: done.map((d) => ({ ...d, title: titleOf[d.projectId] ?? d.file })),
    missingDependencies: skipped.length,
  };
}

/** Met à jour les fichiers indiqués (ou tous ceux qui ont une mise à jour). */
async function update({ gameDir, kind, instance, files = null, trash }) {
  const current = await listContent({ gameDir, kind, instance });
  if (!current.online) throw new Error(t('content.modrinth_est_injoignable_mise_jour'));
  const targets = current.items.filter((i) => i.update && (!files || files.includes(i.file)));
  const updated = [];
  for (const item of targets) {
    const result = await install({ gameDir, kind, instance, projectId: item.projectId, versionId: item.update.versionId, trash });
    updated.push(...result.installed.filter((d) => !d.dependency));
  }
  return updated;
}

/** Copie des fichiers glissés dans la fenêtre. */
async function importFiles({ gameDir, kind, paths }) {
  const info = kindInfo(kind);
  const dir = contentDir(gameDir, kind);
  await fsp.mkdir(dir, { recursive: true });
  const copied = [];
  for (const source of paths) {
    if (typeof source !== 'string' || !source.toLowerCase().endsWith(info.extension)) continue;
    const stat = await fsp.stat(source).catch(() => null);
    if (!stat?.isFile()) continue;
    await fsp.copyFile(source, path.join(dir, path.basename(source)));
    copied.push(path.basename(source));
  }
  return copied;
}

module.exports = { KINDS, loadersFor, contentDir, safePath, listContent, versionPlan, toggle, install, update, importFiles };
