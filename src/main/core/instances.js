'use strict';

// Instances : un dossier par instance (instance.json + dossier du jeu « minecraft »).
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { exists, readJson, writeJson } = require('./store');
const { isInstalled } = require('./versions');
const modSets = require('./mod-sets');

const DEFAULT_SETTINGS = {
  ram: 4,
  java: 'auto', // 'auto' ou 'custom'
  javaPath: '',
  width: 1280,
  height: 720,
  fullscreen: false,
  jvmArgs: '',
  lowRamWarning: true,
  afterLaunch: 'minimize', // 'keep' | 'minimize' | 'hide'
  jvmPreset: 'auto', // 'auto' | 'g1' | 'zgc' | 'none' (voir performance.js)
  priority: 'normal', // 'normal' | 'above' : priorité du processus du jeu
};
const ICONS = new Set(['grass', 'diamond', 'stone', 'netherrack', 'sand', 'end']);
const LOADERS = new Set(['vanilla', 'fabric', 'quilt', 'forge', 'neoforge']);

function checkLoader(loader = 'vanilla', loaderVersion = null) {
  if (!LOADERS.has(loader)) throw new Error('Loader de mods inconnu.');
  if (loader === 'vanilla') return { loader, loaderVersion: null };
  if (typeof loaderVersion !== 'string' || !/^[\w.+-]{1,64}$/.test(loaderVersion)) throw new Error('Choisis une version du loader.');
  return { loader, loaderVersion };
}

/** Nom de groupe de la barre latérale ; vide = sans groupe. */
function cleanGroup(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/\s+/g, ' ').trim().slice(0, 30) || null;
}

/** Compte propre à l'instance ; vide = le compte actif du launcher. */
const cleanAccount = (value) => (typeof value === 'string' && value ? value.slice(0, 80) : null);

const BACKGROUNDS = new Set(['sunset', 'night', 'forest', 'image']);
const BACKGROUND_FILE = /^fond-\d+\.(png|jpg|webp)$/;
const BACKGROUND_MAX = 10 * 1024 * 1024;

/** Vérifie les premiers octets : l'extension seule ne prouve rien. */
function imageExtension(head) {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

const pad = (n) => String(n).padStart(2, '0');
/** Clé « 2026-11-03 » dans le fuseau local. */
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function slugify(name) {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'instance'
  );
}

function sanitizeSettings(input, base = DEFAULT_SETTINGS) {
  const s = { ...base };
  if (input == null) return s;
  if (Number.isFinite(input.ram)) s.ram = Math.min(64, Math.max(0.5, input.ram));
  if (input.java === 'auto' || input.java === 'custom') s.java = input.java;
  if (typeof input.javaPath === 'string') s.javaPath = input.javaPath.trim();
  if (Number.isInteger(input.width) && input.width >= 320) s.width = input.width;
  if (Number.isInteger(input.height) && input.height >= 240) s.height = input.height;
  if (typeof input.fullscreen === 'boolean') s.fullscreen = input.fullscreen;
  if (typeof input.jvmArgs === 'string') s.jvmArgs = input.jvmArgs;
  if (typeof input.lowRamWarning === 'boolean') s.lowRamWarning = input.lowRamWarning;
  if (['keep', 'minimize', 'hide'].includes(input.afterLaunch)) s.afterLaunch = input.afterLaunch;
  if (['auto', 'g1', 'zgc', 'none'].includes(input.jvmPreset)) s.jvmPreset = input.jvmPreset;
  if (['normal', 'above'].includes(input.priority)) s.priority = input.priority;
  return s;
}

class InstanceStore {
  constructor(dirs) {
    this.dirs = dirs;
  }

  dir(id) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Instance invalide.');
    return path.join(this.dirs.instances, id);
  }

  gameDir(id) {
    return path.join(this.dir(id), 'minecraft');
  }

  file(id) {
    return path.join(this.dir(id), 'instance.json');
  }

  get(id) {
    const data = readJson(this.file(id), null);
    if (!data) throw new Error('Instance introuvable.');
    const loader = LOADERS.has(data.loader) ? data.loader : 'vanilla';
    const done = data.loaderInstalled;
    const loaderReady =
      loader === 'vanilla' ||
      (done?.loader === loader && done.loaderVersion === data.loaderVersion && exists(path.join(this.dirs.versions, done.versionId, `${done.versionId}.json`)));
    return {
      ...data,
      loader,
      loaderVersion: loader === 'vanilla' ? null : data.loaderVersion,
      settings: sanitizeSettings(data.settings),
      ...modSets.sanitize(data.modSets, data.activeModSet),
      installed: isInstalled(this.dirs, data.version) && loaderReady,
    };
  }

  /** Ensembles de mods (validés) et ensemble actif. */
  saveModSets(id, sets, active) {
    const current = readJson(this.file(id), null);
    if (!current) throw new Error('Instance introuvable.');
    Object.assign(current, modSets.sanitize(sets, active));
    writeJson(this.file(id), current);
  }

  /** Modpack d'origine : { projectId, versionId, name, version, icon, files } (null pour l'effacer). */
  setModpack(id, modpack) {
    const current = readJson(this.file(id), null);
    if (!current) throw new Error('Instance introuvable.');
    current.modpack = modpack;
    writeJson(this.file(id), current);
  }

  /** Instance importée d'un autre launcher : origine ({ launcher, path, name }) et temps de jeu repris. */
  markImported(id, { from, playtime = 0, lastPlayedAt = null }) {
    const current = readJson(this.file(id), null);
    if (!current) throw new Error('Instance introuvable.');
    current.importedFrom = from;
    current.playtime = Math.max(0, Math.round(playtime));
    current.lastPlayedAt = lastPlayedAt;
    writeJson(this.file(id), current);
  }

  /** Mémorise le loader installé, pour savoir si l'instance est prête sans relancer l'installeur. */
  markLoaderInstalled(id, versionId) {
    const current = readJson(this.file(id), null);
    if (!current) return;
    current.loaderInstalled = { loader: current.loader, loaderVersion: current.loaderVersion, versionId };
    writeJson(this.file(id), current);
  }

  list() {
    let ids = [];
    try {
      ids = fs.readdirSync(this.dirs.instances, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
    return ids
      .filter((id) => /^[a-z0-9-]+$/.test(id))
      .map((id) => {
        try {
          return this.get(id);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (b.lastPlayedAt ?? b.createdAt ?? 0) - (a.lastPlayedAt ?? a.createdAt ?? 0));
  }

  create({ name, icon, version, loader, loaderVersion, group, accountId }, defaults) {
    const cleanName = String(name ?? '').trim().slice(0, 40);
    if (!cleanName) throw new Error('Donne un nom à ton instance.');
    if (!version) throw new Error('Choisis une version de Minecraft.');
    const id = this.freeId(cleanName);

    const data = {
      id,
      name: cleanName,
      icon: ICONS.has(icon) ? icon : 'grass',
      version,
      ...checkLoader(loader, loaderVersion),
      group: cleanGroup(group),
      accountId: cleanAccount(accountId),
      seed: Math.floor(Math.random() * 900) + 50,
      createdAt: Date.now(),
      lastPlayedAt: null,
      playtime: 0,
      settings: sanitizeSettings(defaults),
    };
    fs.mkdirSync(this.gameDir(id), { recursive: true });
    writeJson(this.file(id), data);
    return this.get(id);
  }

  update(id, patch) {
    const current = readJson(this.file(id), null);
    if (!current) throw new Error('Instance introuvable.');
    const next = { ...current };
    if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim().slice(0, 40);
    if (ICONS.has(patch.icon)) next.icon = patch.icon;
    if (typeof patch.version === 'string' && patch.version) next.version = patch.version;
    if (patch.loader !== undefined) Object.assign(next, checkLoader(patch.loader, patch.loaderVersion));
    if (patch.group !== undefined) next.group = cleanGroup(patch.group);
    if (patch.accountId !== undefined) next.accountId = cleanAccount(patch.accountId);
    if (patch.background !== undefined) next.background = this.cleanBackground(id, patch.background);
    if (patch.settings) next.settings = sanitizeSettings(patch.settings, sanitizeSettings(current.settings));
    writeJson(this.file(id), next);
    if (patch.background !== undefined) this.cleanBackgroundFiles(id);
    return this.get(id);
  }

  /** Fond de l'instance : { kind, dim, image? } ; null = décor par défaut. */
  cleanBackground(id, value) {
    if (value == null) return null;
    if (!BACKGROUNDS.has(value.kind)) throw new Error('Fond inconnu.');
    const dim = Number.isFinite(value.dim) ? Math.min(100, Math.max(0, Math.round(value.dim))) : 0;
    if (value.kind !== 'image') return { kind: value.kind, dim };
    if (typeof value.image !== 'string' || !BACKGROUND_FILE.test(value.image) || !exists(path.join(this.dir(id), value.image))) throw new Error('Image de fond introuvable.');
    return { kind: 'image', dim, image: value.image };
  }

  /** Copie une image choisie dans le dossier de l'instance (png, jpeg ou webp, 10 Mo au maximum). Renvoie le nom du fichier. */
  async importBackground(id, file) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Fichier invalide.');
    if (!/\.(png|jpe?g|webp)$/i.test(file)) throw new Error('Choisis une image PNG, JPEG ou WebP.');
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('Fichier invalide.');
    if (stat.size > BACKGROUND_MAX) throw new Error('Cette image est trop lourde (10 Mo au maximum).');
    const handle = await fsp.open(file, 'r');
    let head;
    try {
      const buffer = Buffer.alloc(16);
      const { bytesRead } = await handle.read(buffer, 0, 16, 0);
      head = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const ext = imageExtension(head);
    if (!ext) throw new Error("Ce fichier n'est pas une image PNG, JPEG ou WebP valide.");
    const name = `fond-${Date.now()}.${ext}`;
    await fsp.copyFile(file, path.join(this.dir(id), name));
    return name;
  }

  /** Chemin d'une image de fond de l'instance, ou null si le nom n'est pas valable. */
  backgroundFile(id, name) {
    return BACKGROUND_FILE.test(name) ? path.join(this.dir(id), name) : null;
  }

  /** Supprime les images de fond qui ne sont plus utilisées (remplacées, annulées ou fond retiré). */
  cleanBackgroundFiles(id) {
    const used = readJson(this.file(id), null)?.background?.image;
    try {
      for (const name of fs.readdirSync(this.dir(id))) {
        if (BACKGROUND_FILE.test(name) && name !== used) fs.rmSync(path.join(this.dir(id), name), { force: true });
      }
    } catch {
      // dossier illisible : rien à nettoyer
    }
  }

  /** Fin d'une partie : temps total, minutes par jour (une partie à cheval sur minuit compte sur les deux jours), record. */
  recordPlay(id, minutes, endedAt = Date.now()) {
    const current = readJson(this.file(id), null);
    if (!current) return;
    current.playtime = (current.playtime ?? 0) + minutes;
    current.lastPlayedAt = endedAt;
    if (minutes >= 1) {
      const startedAt = endedAt - minutes * 60000;
      const stats = { days: {}, sessions: 0, longest: 0, since: startedAt, ...current.stats };
      for (let cursor = startedAt; cursor < endedAt; ) {
        const day = new Date(cursor);
        const slice = Math.min(endedAt, new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime()) - cursor;
        const key = dayKey(day);
        stats.days[key] = Math.round(((stats.days[key] ?? 0) + slice / 60000) * 10) / 10;
        cursor += slice;
      }
      // Un peu plus d'un an d'historique suffit pour les graphiques.
      const keys = Object.keys(stats.days).sort();
      for (const key of keys.slice(0, Math.max(0, keys.length - 400))) delete stats.days[key];
      stats.sessions += 1;
      stats.longest = Math.max(stats.longest, minutes);
      current.stats = stats;
    }
    writeJson(this.file(id), current);
  }

  /** Identifiant de dossier libre, tiré du nom (« survie », « survie-2 »…). */
  freeId(name) {
    const base = slugify(name);
    let id = base;
    for (let n = 2; fs.existsSync(this.dir(id)); n++) id = `${base}-${n}`;
    return id;
  }

  /** Copie complète (mondes, options, packs…) sous un nouveau nom. Les natives sont réextraites au lancement. */
  async duplicate(id, name) {
    const source = readJson(this.file(id), null);
    if (!source) throw new Error('Instance introuvable.');
    const cleanName = String(name ?? '').trim().slice(0, 40) || `${source.name} (copie)`.slice(0, 40);
    const copyId = this.freeId(cleanName);
    await fsp.cp(this.dir(id), this.dir(copyId), {
      recursive: true,
      filter: (src) => path.basename(src) !== 'natives' || path.dirname(src) !== this.dir(id),
    });
    writeJson(this.file(copyId), {
      ...source,
      id: copyId,
      name: cleanName,
      seed: Math.floor(Math.random() * 900) + 50,
      createdAt: Date.now(),
      lastPlayedAt: null,
      playtime: 0,
      stats: undefined,
      importedFrom: undefined,
    });
    return this.get(copyId);
  }
}

module.exports = { InstanceStore, DEFAULT_SETTINGS, sanitizeSettings, slugify };
