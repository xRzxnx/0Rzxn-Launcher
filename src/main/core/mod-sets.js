'use strict';

// Ensembles de mods d'une instance : des groupes de mods actifs, sans rien désinstaller.
// Un mod est repéré par un identifiant stable (id du mod lu dans le jar, sinon nom de fichier
// sans « .disabled »), pour rester dans son ensemble quand une mise à jour change le nom du fichier.
const crypto = require('node:crypto');
const content = require('./content');

const MAX_SETS = 20;
const MAX_MODS = 3000;
const NAME_MAX = 30;

/** Identifiant stable d'un mod listé par `content.listContent`. */
function stableId(item) {
  if (typeof item.modId === 'string' && item.modId) return `m:${item.modId.toLowerCase()}`;
  return `f:${String(item.file).replace(/\.disabled$/, '').toLowerCase()}`;
}

function cleanName(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '';
}

/** Valide les ensembles lus dans instance.json : forme, doublons, limites. */
function sanitize(modSets, activeModSet) {
  const seen = new Set();
  const sets = [];
  for (const raw of Array.isArray(modSets) ? modSets : []) {
    const name = cleanName(raw?.name);
    if (!name || typeof raw.id !== 'string' || !/^[a-z0-9]{4,16}$/.test(raw.id) || seen.has(raw.id) || sets.length >= MAX_SETS) continue;
    seen.add(raw.id);
    const mods = [...new Set((Array.isArray(raw.mods) ? raw.mods : []).filter((m) => typeof m === 'string' && m.length > 0 && m.length <= 200))].slice(0, MAX_MODS);
    sets.push({ id: raw.id, name, mods });
  }
  return { modSets: sets, activeModSet: sets.some((s) => s.id === activeModSet) ? activeModSet : null };
}

function assertModded(instance) {
  if (instance.loader === 'vanilla') throw new Error('Les ensembles de mods demandent un loader (Fabric, Quilt, Forge ou NeoForge).');
}

async function items(gameDir, instance) {
  return (await content.listContent({ gameDir, kind: 'mods', instance, online: false })).items.filter((i) => !i.isFolder);
}

function uniqueName(sets, name, exceptId = null) {
  const clean = cleanName(name);
  if (!clean) throw new Error('Donne un nom à ton ensemble.');
  if (sets.some((s) => s.id !== exceptId && s.name.toLowerCase() === clean.toLowerCase())) throw new Error('Un ensemble porte déjà ce nom.');
  return clean;
}

/** Crée un ensemble avec les mods actifs du moment, et l'active. */
async function create({ store, instance, gameDir, name }) {
  assertModded(instance);
  const sets = instance.modSets ?? [];
  if (sets.length >= MAX_SETS) throw new Error(`${MAX_SETS} ensembles au maximum.`);
  const clean = uniqueName(sets, name);
  const mods = [...new Set((await items(gameDir, instance)).filter((i) => i.enabled).map(stableId))];
  const set = { id: crypto.randomBytes(4).toString('hex'), name: clean, mods };
  store.saveModSets(instance.id, [...sets, set], set.id);
  return set;
}

function rename({ store, instance, setId, name }) {
  const sets = instance.modSets ?? [];
  if (!sets.some((s) => s.id === setId)) throw new Error('Ensemble introuvable.');
  const clean = uniqueName(sets, name, setId);
  store.saveModSets(instance.id, sets.map((s) => (s.id === setId ? { ...s, name: clean } : s)), instance.activeModSet);
}

/** Supprime l'ensemble seulement : aucun mod n'est touché. */
function remove({ store, instance, setId }) {
  const sets = instance.modSets ?? [];
  if (!sets.some((s) => s.id === setId)) throw new Error('Ensemble introuvable.');
  store.saveModSets(instance.id, sets.filter((s) => s.id !== setId), instance.activeModSet === setId ? null : instance.activeModSet);
}

/**
 * Active un ensemble (ses mods sont activés, les autres désactivés) ou, avec `setId` nul, tous les mods.
 * Si certains fichiers résistent, l'ensemble n'est plus considéré comme actif et la liste des échecs est renvoyée.
 */
async function apply({ store, instance, gameDir, setId }) {
  assertModded(instance);
  const sets = instance.modSets ?? [];
  const set = setId == null ? null : sets.find((s) => s.id === setId);
  if (setId != null && !set) throw new Error('Ensemble introuvable.');
  const wanted = set ? new Set(set.mods) : null;
  const failed = [];
  let changed = 0;
  for (const item of await items(gameDir, instance)) {
    const shouldBeOn = wanted ? wanted.has(stableId(item)) : true;
    if (item.enabled === shouldBeOn) continue;
    try {
      await content.toggle({ gameDir, kind: 'mods', file: item.file });
      changed++;
    } catch (error) {
      failed.push({ file: item.file, message: error.message });
    }
  }
  store.saveModSets(instance.id, sets, failed.length || !set ? null : set.id);
  return { changed, failed };
}

/**
 * À appeler après un changement du dossier des mods (interrupteur, installation, mise à jour, suppression) :
 * l'ensemble actif reprend les mods actifs (un mod installé ou activé y entre, un mod désactivé en sort),
 * et les mods supprimés sortent de tous les ensembles.
 */
async function sync({ store, instance, gameDir }) {
  const sets = instance.modSets ?? [];
  if (!sets.length) return;
  const all = await items(gameDir, instance);
  const present = new Set(all.map(stableId));
  const enabled = new Set(all.filter((i) => i.enabled).map(stableId));
  const next = sets.map((s) => (s.id === instance.activeModSet ? { ...s, mods: [...enabled] } : { ...s, mods: s.mods.filter((m) => present.has(m)) }));
  if (JSON.stringify(next) !== JSON.stringify(sets)) store.saveModSets(instance.id, next, instance.activeModSet);
}

module.exports = { stableId, sanitize, create, rename, remove, apply, sync };
