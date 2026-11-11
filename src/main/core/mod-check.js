'use strict';

// Diagnostic des mods avant le lancement : lit les métadonnées locales des jars (sans réseau)
// et repère les dépendances absentes, les conflits déclarés et les doublons.
const { currentLanguage, t } = require('../i18n');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const zip = require('./zip');
const hashCache = require('./hash-cache');

const DISABLED = '.disabled';
const IGNORED = new Set(['java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilt-loader', 'forge', 'neoforge', 'minecraft']);
const MAX_DEPTH = 2;
const LOADER_NAMES = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
// Formats de mods que chaque loader sait charger.
const ACCEPTS = { fabric: ['fabric'], quilt: ['quilt', 'fabric'], forge: ['forge'], neoforge: ['neoforge', 'forge'] };

// ---------- Versions et plages ----------

/** Parties numériques d'une version (« 1.21.1-beta+x » → [1, 21, 1]), ou null si illisible. */
function parts(version) {
  if (typeof version !== 'string') return null;
  const m = version.trim().replace(/^v/i, '').match(/^(\d+(?:\.\d+)*)/);
  return m ? m[1].split('.').map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Plage de style Fabric/Quilt : true, false, ou null si le format n'est pas compris. */
function matchFabricRange(range, version) {
  const v = parts(version);
  if (!v) return null;
  const ranges = Array.isArray(range) ? range : [range];
  let unknown = false;
  for (const r of ranges) {
    if (typeof r !== 'string') return null;
    for (const alt of r.split('||')) {
      const result = matchAll(alt.trim(), v);
      if (result === true) return true;
      if (result === null) unknown = true;
    }
  }
  return unknown ? null : false;
}

function matchAll(expression, v) {
  if (expression === '' || expression === '*') return true;
  let unknown = false;
  const tokens = expression.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i];
    // « >= 1.2 » écrit avec une espace
    if (/^(>=|<=|>|<|=|~|\^)$/.test(token) && tokens[i + 1]) token += tokens[++i];
    const r = matchOne(token, v);
    if (r === false) return false;
    if (r === null) unknown = true;
  }
  return unknown ? null : true;
}

function matchOne(token, v) {
  const m = token.match(/^(>=|<=|>|<|=|~|\^)?(.+)$/);
  if (!m) return null;
  const op = m[1] ?? '';
  const raw = m[2].replace(/[-+].*$/, '');
  if (raw === '*' || raw === 'x' || raw === 'X') return true;
  if (/[xX*]$/.test(raw)) {
    const prefix = parts(raw.replace(/\.?[xX*]$/, ''));
    if (!prefix || op) return null;
    return compare(v.slice(0, prefix.length), prefix) === 0;
  }
  const target = parts(raw);
  if (!target || !/^\d+(\.\d+)*$/.test(raw)) return null;
  switch (op) {
    case '>=': return compare(v, target) >= 0;
    case '>': return compare(v, target) > 0;
    case '<=': return compare(v, target) <= 0;
    case '<': return compare(v, target) < 0;
    case '':
    case '=': return compare(v, target) === 0;
    case '~': {
      const upper = target.length > 1 ? [target[0], target[1] + 1] : [target[0] + 1];
      return compare(v, target) >= 0 && compare(v, upper) < 0;
    }
    case '^': {
      if (target[0] === 0) return null;
      return compare(v, target) >= 0 && compare(v, [target[0] + 1]) < 0;
    }
    default: return null;
  }
}

/** Plage de style Maven (Forge/NeoForge) : « [1.20,1.21) », « [1.21.1] », unions séparées par des virgules. */
function matchMavenRange(range, version) {
  const v = parts(version);
  if (!v || typeof range !== 'string') return null;
  const pattern = /([[(])\s*([^,\])[(]*?)\s*(?:,\s*([^,\])[(]*?)\s*)?([\])])/g;
  const leftover = range.replace(pattern, '').replace(/[\s,]/g, '');
  if (leftover) return null;
  let any = false;
  let result = false;
  for (const m of range.matchAll(pattern)) {
    any = true;
    const [, open, low, high, closeBracket] = m;
    if (high === undefined) {
      const exact = parts(low);
      if (!exact) return null;
      if (compare(v, exact) === 0) result = true;
      continue;
    }
    const lo = low ? parts(low) : [];
    const hi = high ? parts(high) : null;
    if (!lo || (high && !hi)) return null;
    const aboveLow = !low || (open === '[' ? compare(v, lo) >= 0 : compare(v, lo) > 0);
    const belowHigh = !high || (closeBracket === ']' ? compare(v, hi) <= 0 : compare(v, hi) < 0);
    if (aboveLow && belowHigh) result = true;
  }
  return any ? result : null;
}

// ---------- Lecture des jars ----------

function tomlSections(text) {
  const sections = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\[\s*([^\]]+?)\s*\]\]/);
    if (header) {
      current = { name: header[1], values: {} };
      sections.push(current);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    const kv = line.match(/^\s*([A-Za-z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/);
    if (kv && current) current.values[kv[1]] = kv[2] ?? kv[3] ?? kv[4];
  }
  return sections;
}

function jsonEntry(buffer, entries, name) {
  try {
    return JSON.parse(zip.readFile(buffer, name, entries)?.toString('utf8') ?? 'null');
  } catch {
    return null;
  }
}

function fabricLikeDeps(source, list) {
  // Fabric : objet { id: plage } ; Quilt : tableau de chaînes ou d'objets { id, versions, optional, unless }.
  const out = [];
  if (Array.isArray(source)) {
    for (const item of source) {
      if (typeof item === 'string') out.push({ id: item, range: '*' });
      else if (item && typeof item.id === 'string') {
        if (item.optional || item.unless) continue;
        const versions = item.versions ?? '*';
        out.push({ id: item.id, range: typeof versions === 'string' || (Array.isArray(versions) && versions.every((x) => typeof x === 'string')) ? versions : null });
      }
    }
  } else if (source && typeof source === 'object') {
    for (const [id, range] of Object.entries(source)) out.push({ id, range });
  }
  list.push(...out);
}

function empty() {
  return { mainIds: [], provided: [], depends: [], breaks: [], name: null, version: null, found: false, madeFor: null };
}

function parseFabric(buffer, entries, depth) {
  const data = jsonEntry(buffer, entries, 'fabric.mod.json');
  if (!data || typeof data.id !== 'string') return null;
  const info = empty();
  info.found = true;
  info.madeFor = 'fabric';
  info.mainIds = [data.id];
  info.name = data.name ?? data.id;
  info.version = data.version;
  if (Array.isArray(data.provides)) info.provided.push(...data.provides.filter((x) => typeof x === 'string'));
  fabricLikeDeps(data.depends, info.depends);
  fabricLikeDeps(data.breaks, info.breaks);
  const nested = (Array.isArray(data.jars) ? data.jars : []).map((j) => j?.file).filter((f) => typeof f === 'string');
  addNested(buffer, entries, nested, info, depth);
  return info;
}

function parseQuilt(buffer, entries, depth) {
  const q = jsonEntry(buffer, entries, 'quilt.mod.json')?.quilt_loader;
  if (!q || typeof q.id !== 'string') return null;
  const info = empty();
  info.found = true;
  info.madeFor = 'quilt';
  info.mainIds = [q.id];
  info.name = q.metadata?.name ?? q.id;
  info.version = q.version;
  for (const p of Array.isArray(q.provides) ? q.provides : []) {
    const id = typeof p === 'string' ? p : p?.id;
    if (typeof id === 'string') info.provided.push(id);
  }
  fabricLikeDeps(q.depends, info.depends);
  fabricLikeDeps(q.breaks, info.breaks);
  addNested(buffer, entries, (Array.isArray(q.jars) ? q.jars : []).filter((f) => typeof f === 'string'), info, depth);
  return info;
}

function parseToml(buffer, entries, depth, preferNeo) {
  const names = preferNeo ? ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml'] : ['META-INF/mods.toml', 'META-INF/neoforge.mods.toml'];
  const tomlName = names.find((n) => zip.readFile(buffer, n, entries));
  if (!tomlName) return null;
  const toml = zip.readFile(buffer, tomlName, entries).toString('utf8');
  const info = empty();
  info.madeFor = tomlName.includes('neoforge') ? 'neoforge' : 'forge';
  const sections = tomlSections(toml);
  for (const s of sections) {
    if (s.name === 'mods' && s.values.modId) {
      info.mainIds.push(s.values.modId);
      info.name ??= s.values.displayName;
      info.version ??= s.values.version;
    }
  }
  if (!info.mainIds.length) return null;
  info.found = true;
  for (const s of sections) {
    if (!s.name.startsWith('dependencies') || !s.values.modId) continue;
    const range = s.values.versionRange ?? '*';
    const type = s.values.type?.toLowerCase();
    if (type === 'incompatible') info.breaks.push({ id: s.values.modId, range, maven: true });
    else if (s.values.mandatory === 'true' || type === 'required') info.depends.push({ id: s.values.modId, range, maven: true });
  }
  addNested(buffer, entries, jarJarFiles(buffer, entries), info, depth, preferNeo);
  return info;
}

/** Jars imbriqués Forge/NeoForge : ceux listés par META-INF/jarjar/metadata.json (rangés où le mod veut), plus ceux du dossier jarjar. */
function jarJarFiles(buffer, entries) {
  const listed = jsonEntry(buffer, entries, 'META-INF/jarjar/metadata.json')?.jars;
  const fromList = (Array.isArray(listed) ? listed : []).map((j) => j?.path).filter((p) => typeof p === 'string');
  const inFolder = entries.map((e) => e.name).filter((n) => /^META-INF\/jarjar\/.+\.jar$/i.test(n));
  return [...new Set([...fromList, ...inFolder])];
}

/** Les mods fournis par un jar imbriqué comptent comme présents. */
function addNested(buffer, entries, files, info, depth, preferNeo = false) {
  if (depth >= MAX_DEPTH) return;
  for (const file of files) {
    try {
      const inner = zip.readFile(buffer, file.replace(/^\//, ''), entries);
      if (!inner) continue;
      const sub = parseJar(inner, 'any', depth + 1, preferNeo);
      info.provided.push(...sub.mainIds, ...sub.provided);
    } catch {
      // jar imbriqué illisible : ignoré
    }
  }
}

/** Ordre de lecture des métadonnées selon le loader de l'instance. */
function parseJar(buffer, loader, depth = 0, preferNeo = loader === 'neoforge') {
  const entries = zip.listEntries(buffer);
  const readers = {
    fabric: () => parseFabric(buffer, entries, depth),
    quilt: () => parseQuilt(buffer, entries, depth),
    toml: () => parseToml(buffer, entries, depth, preferNeo),
  };
  const order = {
    fabric: ['fabric', 'quilt', 'toml'],
    quilt: ['quilt', 'fabric', 'toml'],
    forge: ['toml', 'fabric', 'quilt'],
    neoforge: ['toml', 'fabric', 'quilt'],
  }[loader] ?? ['fabric', 'quilt', 'toml'];
  let info = null;
  for (const key of order) {
    info = readers[key]();
    if (info) break;
  }
  info ??= empty();
  info.optifine = depth === 0 && entries.some((e) => /^(net\/optifine\/|optifine\/)/.test(e.name));
  return info;
}

// ---------- Analyse ----------

const fileCache = new Map(); // chemin → { mtimeMs, size, loader, info }
const resultCache = new Map(); // dossier des mods → { key, problems, count }

async function readJar(file, stat, loader) {
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size && hit.loader === loader) return hit.info;
  // Déjà lu lors d'une ouverture précédente du launcher, pour ce loader (launcher.db).
  const part = `check:${loader}`;
  const kept = hashCache.recall(file, stat, part);
  if (kept) {
    fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, loader, info: kept.value });
    return kept.value;
  }
  let info;
  let sha1 = null;
  try {
    const buffer = await fsp.readFile(file);
    sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
    info = parseJar(buffer, loader);
  } catch {
    info = empty(); // archive illisible : aucun avis
  }
  fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, loader, info });
  if (sha1) hashCache.remember(file, stat, sha1, part, info);
  return info;
}

function listJoin(names) {
  const unique = [...new Set(names)];
  if (unique.length <= 1) return unique[0] ?? '';
  return `${unique.slice(0, -1).join(', ')} et ${unique[unique.length - 1]}`;
}

function analyse(mods, instance) {
  const problems = [];
  // Un jar pour un autre loader ne sera jamais chargé : il ne fournit rien et ne réclame rien.
  const accepted = ACCEPTS[instance.loader];
  const isForeign = (m) => Boolean(accepted && m.info.madeFor && !accepted.includes(m.info.madeFor));
  const usable = mods.filter((m) => !isForeign(m));
  const active = usable.filter((m) => m.enabled);
  const idsOf = (m) => [...m.info.mainIds, ...m.info.provided];

  const present = new Map(); // id → mods actifs
  const dormant = new Map(); // id → mods désactivés
  for (const m of usable) {
    const target = m.enabled ? present : dormant;
    const ids = new Set(idsOf(m));
    if (m.info.optifine) ids.add('optifine');
    for (const id of ids) {
      if (!target.has(id)) target.set(id, []);
      target.get(id).push(m);
    }
  }
  const label = (m) => m.info.name || m.file.replace(DISABLED, '').replace(/\.jar$/i, '');

  for (const m of mods) {
    if (!m.enabled || !isForeign(m)) continue;
    problems.push({
      id: `loader:${m.file}`,
      severity: 'blocking',
      title: t('mod_check.autre_loader'),
      text: t('mod_check.fait_pour_autre_loader', { m: label(m), madeFor: LOADER_NAMES[m.info.madeFor], loader: LOADER_NAMES[instance.loader] }),
      action: { type: 'disable', label: t('mod_check.desactiver'), file: m.file },
      foreign: true,
    });
  }

  // Dépendances obligatoires
  const missing = new Map(); // id → { mods, disabled }
  const outdated = new Map(); // id → { mods, provider }
  const minecraft = instance.version;
  for (const m of active) {
    const own = new Set(idsOf(m));
    for (const dep of m.info.depends) {
      if (own.has(dep.id)) continue;
      if (dep.id === 'minecraft') {
        const ok = dep.maven ? matchMavenRange(dep.range, minecraft) : matchFabricRange(dep.range, minecraft);
        if (ok === false) {
          problems.push({
            id: `mc:${m.file}`,
            severity: 'blocking',
            title: t('mod_check.version_de_minecraft'),
            text: t('mod_check.est_pas_prevu_pour_minecraft', { m: label(m), minecraft }),
            action: null,
          });
        }
        continue;
      }
      if (IGNORED.has(dep.id)) continue;
      if (present.has(dep.id)) {
        // Seule la version du mod lui-même est connue, pas celle d'un jar imbriqué.
        const provider = present.get(dep.id).find((p) => p.info.mainIds.includes(dep.id));
        if (provider && dep.range !== '*' && dep.range != null) {
          const ok = dep.maven ? matchMavenRange(dep.range, provider.info.version) : matchFabricRange(dep.range, provider.info.version);
          if (ok === false && !outdated.has(dep.id)) outdated.set(dep.id, { mods: [label(m)], provider });
          else if (ok === false && !outdated.get(dep.id).mods.includes(label(m))) outdated.get(dep.id).mods.push(label(m));
        }
        continue;
      }
      if (!missing.has(dep.id)) missing.set(dep.id, { mods: [], disabled: dormant.get(dep.id)?.[0] ?? null });
      missing.get(dep.id).mods.push(label(m));
    }
  }
  for (const [id, { mods: needers, disabled }] of missing) {
    if (disabled) {
      problems.push({
        id: `dep:${id}`,
        severity: 'blocking',
        title: t('mod_check.dependance_desactivee'),
        text: t('mod_check.dep_disabled', { count: needers.length, mods: listJoin(needers), dep: label(disabled) }),
        action: { type: 'enable', label: t('mod_check.activer'), file: disabled.file },
      });
    } else {
      problems.push({
        id: `dep:${id}`,
        severity: 'blocking',
        title: t('mod_check.dependance_manquante'),
        text: t('mod_check.dep_missing', { count: needers.length, mods: listJoin(needers), id }),
        action: null,
        dependency: { id },
      });
    }
  }
  for (const [id, { mods: needers, provider }] of outdated) {
    problems.push({
      id: `dep-old:${id}`,
      severity: 'blocking',
      title: t('mod_check.dependance_trop_ancienne'),
      text: t('mod_check.dep_outdated', { count: needers.length, mods: listJoin(needers), dep: label(provider), version: provider.info.version }),
      action: null,
      dependency: { id, outdated: provider.file },
    });
  }

  // Doublons : même identifiant principal dans plusieurs jars actifs
  const byMain = new Map();
  for (const m of active) {
    for (const id of new Set(m.info.mainIds)) {
      if (!byMain.has(id)) byMain.set(id, []);
      byMain.get(id).push(m);
    }
  }
  const dupFiles = new Set();
  for (const [id, group] of byMain) {
    if (group.length < 2) continue;
    // on garde le plus récent (version la plus haute, sinon le dernier par nom)
    const sorted = [...group].sort((a, b) => {
      const va = parts(a.info.version);
      const vb = parts(b.info.version);
      if (va && vb && compare(va, vb)) return compare(va, vb);
      return a.file.localeCompare(b.file, 'fr', { numeric: true });
    });
    const drop = sorted[0];
    if (dupFiles.has(drop.file)) continue;
    dupFiles.add(drop.file);
    problems.push({
      id: `dup:${id}`,
      severity: 'risk',
      title: t('mod_check.mod_en_double'),
      text: t('mod_check.contiennent_tous_le_mod_le', { group: listJoin(group.map((g) => g.file)), id, file: drop.file }),
      action: { type: 'disable', label: t('mod_check.desactiver'), file: drop.file },
    });
  }

  // Incompatibilités déclarées
  const seenPairs = new Set();
  for (const m of active) {
    for (const b of m.info.breaks) {
      if (IGNORED.has(b.id)) continue;
      const targets = (present.get(b.id) ?? []).filter((t) => t !== m);
      for (const other of targets) {
        const version = other.info.mainIds.includes(b.id) ? other.info.version : null;
        const hit = b.range === '*' ? true : (b.maven ? matchMavenRange(b.range, version) : matchFabricRange(b.range, version));
        if (hit !== true) continue;
        const key = [m.file, other.file].sort().join('|');
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        problems.push({
          id: `breaks:${key}`,
          severity: 'risk',
          title: t('common.mods_incompatibles'),
          text: t('mod_check.se_declare_incompatible_avec', { m: label(m), value: label(other) }),
          action: { type: 'disable', label: t('mod_check.desactiver'), file: other.file, target: label(other) },
        });
      }
    }
  }

  // Sodium / Iris avec OptiFine
  const optifine = present.get('optifine')?.[0];
  if (optifine) {
    for (const [id, name] of [['sodium', 'Sodium'], ['iris', 'Iris']]) {
      if (!present.has(id)) continue;
      problems.push({
        id: `optifine:${id}`,
        severity: 'risk',
        title: t('mod_check.mods_en_double'),
        text: t('mod_check.et_optifine_font_le_meme', { name }),
        action: { type: 'disable', label: t('mod_check.desactiver'), file: optifine.file, target: 'OptiFine' },
      });
    }
  }
  return problems;
}

/**
 * Problèmes à régler avant de lancer. Instance vanilla : aucun contrôle.
 * Résultat gardé tant que le dossier des mods ne change pas (date et nombre de fichiers).
 */
async function check({ gameDir, instance }) {
  const loader = instance.loader;
  if (!loader || loader === 'vanilla') return { count: 0, problems: [] };
  const dir = path.join(gameDir, 'mods');
  let names;
  let dirStat;
  try {
    [names, dirStat] = await Promise.all([fsp.readdir(dir), fsp.stat(dir)]);
  } catch {
    return { count: 0, problems: [] };
  }
  const jars = names.filter((n) => n.replace(DISABLED, '').toLowerCase().endsWith('.jar')).sort();
  const key = `${currentLanguage()}|${dirStat.mtimeMs}|${jars.length}|${loader}|${instance.version}|${jars.join('/')}`;
  const hit = resultCache.get(dir);
  if (hit?.key === key) return hit.result;

  const mods = [];
  for (const file of jars) {
    try {
      const full = path.join(dir, file);
      const stat = await fsp.stat(full);
      if (!stat.isFile()) continue;
      mods.push({ file, enabled: !file.endsWith(DISABLED), info: await readJar(full, stat, loader) });
    } catch {
      // fichier déplacé pendant la lecture
    }
  }
  const result = { count: mods.filter((m) => m.enabled).length, problems: analyse(mods, instance) };
  resultCache.set(dir, { key, result });
  return result;
}

/** Identifiants fournis par un jar, ceux de ses jars imbriqués compris. */
function jarIds(buffer, loader) {
  const info = parseJar(buffer, loader);
  return { ids: [...new Set([...info.mainIds, ...info.provided])] };
}

module.exports = { check, jarIds, matchFabricRange, matchMavenRange };
