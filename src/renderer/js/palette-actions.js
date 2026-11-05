// Recherche globale (Ctrl+K) : calcul des résultats, requêtes Modrinth temporisées et actions.
import { openBackground } from './background-actions.js';
import { openImport } from './import-actions.js';
import { openLauncherFolder, requestLaunch, verifyInstance } from './actions.js';
import { api } from './api.js';
import { LOADER_NAMES } from './data.js';
import { modStableId } from './mods-actions.js';
import { openRecap } from './recap-actions.js';
import { activeAccount, instanceStatus, selectedInstance, state, update } from './state.js';
import { go, openNewInstance, selectInstance } from './views/chrome.js';

const MAX_PER_GROUP = 6;
const REMOTE_DELAY = 300;
const CACHE_LIMIT = 40;

const norm = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (query) => norm(query).split(/\s+/).filter(Boolean);
const hasAll = (haystack, query) => {
  const text = norm(haystack);
  return words(query).every((w) => text.includes(w));
};

// ---------- Ouverture et fermeture ----------

export function openPalette() {
  update((s) => { s.modal = { type: 'palette', query: '', active: 0, reveal: false, remoteTick: 0 }; });
}

export function closePalette() {
  clearTimeout(remoteTimer);
  update((s) => { if (s.modal?.type === 'palette') s.modal = null; });
}

export function togglePalette() {
  if (state.modal?.type === 'palette') closePalette();
  else if (!state.modal && state.ready) openPalette();
}

// ---------- Modrinth ----------

const cache = new Map(); // « instance|texte » → résultats
const inflight = new Set();
let remoteTimer = null;

const remoteKey = (query) => {
  const instance = selectedInstance();
  const text = query.trim().toLowerCase();
  return instance && text.length >= 2 ? `${instance.id}|${text}` : null;
};

function remoteHits(query) {
  const key = remoteKey(query);
  return key ? (cache.get(key) ?? []) : [];
}

/** Une requête par texte, 300 ms après la dernière frappe, jamais deux fois la même, silencieuse si elle échoue. */
function scheduleRemote() {
  clearTimeout(remoteTimer);
  const query = state.modal?.query ?? '';
  const key = remoteKey(query);
  const instance = selectedInstance();
  if (!key || !instance || !api.available || state.versions.offline || cache.has(key)) return;
  remoteTimer = setTimeout(async () => {
    if (inflight.has(key) || cache.has(key)) return;
    inflight.add(key);
    try {
      const data = await api.searchModrinth({ instanceId: instance.id, kind: 'mods', query: query.trim(), sort: 'relevance', offset: 0 });
      cache.set(key, (data?.hits ?? []).slice(0, 8));
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
      update((s) => { if (s.modal?.type === 'palette') s.modal.remoteTick++; });
    } catch {
      // hors connexion ou Modrinth injoignable : le groupe n'apparaît simplement pas
    } finally {
      inflight.delete(key);
    }
  }, REMOTE_DELAY);
}

// ---------- Résultats ----------

function launchInstance(instance, selectOnly) {
  update((s) => { s.modal = null; });
  selectInstance(instance.id);
  if (selectOnly || state.run) return;
  if (!activeAccount()) update((s) => { s.modal = { type: 'accounts' }; });
  else requestLaunch();
}

function openInstalledMod(instanceId, title) {
  update((s) => {
    s.modal = null;
    s.selectedId = instanceId;
    s.view = 'mods';
    s.mods.kind = 'mods';
    s.mods.tab = 'installed';
    s.mods.filter = title;
    s.mods.selected = null;
  });
}

function openDiscover(hit) {
  update((s) => {
    s.modal = null;
    s.view = 'mods';
    s.mods.kind = 'mods';
    s.mods.tab = 'discover';
    s.mods.query = hit.title;
    s.mods.selected = hit.id;
  });
}

function openSettings(scope, anchor) {
  update((s) => {
    s.modal = null;
    s.view = 'settings';
    s.settingsScope = scope;
  });
  if (!anchor) return;
  let tries = 0;
  const reveal = () => {
    const el = document.getElementById(anchor);
    if (el) el.scrollIntoView({ block: 'center' });
    else if (++tries < 10) setTimeout(reveal, 80);
  };
  setTimeout(reveal, 80);
}

function plain(fn) {
  return () => {
    update((s) => { s.modal = null; });
    fn();
  };
}

function instanceItems(query) {
  const text = query.trim();
  const pool = text
    ? state.instances.filter((i) => hasAll(`${i.name} ${i.version} ${LOADER_NAMES[i.loader] ?? ''} ${i.group ?? ''}`, text))
    : [...state.instances].sort((a, b) => (b.lastPlayedAt ?? b.createdAt ?? 0) - (a.lastPlayedAt ?? a.createdAt ?? 0)).slice(0, 4);
  return pool.slice(0, MAX_PER_GROUP).map((instance) => {
    const status = instanceStatus(instance);
    const blocked = Boolean(state.run);
    const base = `${LOADER_NAMES[instance.loader] ?? instance.loader} ${instance.version}`;
    let hint = instance.installed ? 'Entrée pour jouer' : 'Entrée pour installer et jouer';
    if (status.kind === 'running') hint = 'Déjà en jeu · Entrée pour sélectionner';
    else if (blocked) hint = 'Partie en cours · Entrée pour sélectionner';
    return {
      id: `instance:${instance.id}`,
      kind: 'instance',
      instance,
      label: instance.name,
      meta: blocked ? `${base} · ${hint}` : `${base} · ${status.label}`,
      hint: blocked ? null : hint,
      run: (shift) => launchInstance(instance, shift || blocked),
    };
  });
}

function modItems(query) {
  const text = query.trim();
  if (!text) return [];
  const found = new Map();
  const installedProjects = new Set();
  for (const [key, data] of Object.entries(state.mods.installed)) {
    const cut = key.lastIndexOf(':');
    const instanceId = key.slice(0, cut);
    if (key.slice(cut + 1) !== 'mods' || !state.instances.some((i) => i.id === instanceId)) continue;
    for (const item of data.items ?? []) {
      if (item.projectId) installedProjects.add(item.projectId);
      if (!hasAll(`${item.title ?? ''} ${item.name ?? ''} ${item.file ?? ''}`, text)) continue;
      const id = modStableId(item);
      const entry = found.get(id) ?? { title: item.title ?? item.name ?? item.file, instances: [] };
      if (!entry.instances.includes(instanceId)) entry.instances.push(instanceId);
      found.set(id, entry);
    }
  }
  const installed = [...found.values()].slice(0, 5).map((entry) => {
    const target = entry.instances.includes(state.selectedId) ? state.selectedId : entry.instances[0];
    const first = state.instances.find((i) => i.id === entry.instances[0])?.name;
    return {
      id: `mod:${entry.title}`,
      kind: 'mod',
      label: entry.title,
      meta: entry.instances.length === 1 ? `installé dans ${first}` : `installé dans ${entry.instances.length} instances`,
      run: () => openInstalledMod(target, entry.title),
    };
  });
  const remote = remoteHits(text)
    .filter((hit) => !installedProjects.has(hit.id) && !installed.some((i) => norm(i.label) === norm(hit.title)))
    .slice(0, 4)
    .map((hit) => ({
      id: `modrinth:${hit.id}`,
      kind: 'mod',
      label: hit.title,
      meta: 'installer depuis Modrinth',
      run: () => openDiscover(hit),
    }));
  return [...installed, ...remote];
}

function actionItems(query) {
  const instance = selectedInstance();
  const name = instance?.name ?? '';
  const busy = Boolean(state.run);
  const list = [
    { id: 'a:new', icon: 'plus', label: 'Nouvelle instance', keys: 'creer ajouter instance nouvelle', run: plain(() => openNewInstance()), main: true },
    { id: 'a:import', icon: 'download', label: 'Importer une instance', keys: 'importer instance modpack mrpack', run: plain(openImport), main: true },
    { id: 'a:console', icon: 'console', label: 'Ouvrir la console', keys: 'console journaux logs crash', run: plain(() => go('console')), main: true },
    { id: 'a:folder', icon: 'folder', label: 'Dossier du launcher', keys: 'dossier launcher ouvrir', run: plain(openLauncherFolder) },
    instance && {
      id: 'a:verify',
      icon: 'shield',
      label: `Vérifier les fichiers de ${name}`,
      keys: 'verifier fichiers instance reparer',
      meta: !instance.installed ? 'à installer d’abord' : busy ? 'indisponible pendant une partie' : 'action',
      run: instance.installed && !busy ? plain(() => verifyInstance(instance.id)) : () => {},
    },
    { id: 'a:recap', icon: 'bolt', label: 'Bilan du mois', keys: 'bilan mois recap statistiques temps de jeu', run: plain(openRecap), main: true },
    instance && { id: 'a:background', icon: 'edit', label: `Fond de ${name}`, keys: 'fond arriere plan decor image instance', run: plain(() => openBackground(instance)) },
  ].filter(Boolean);
  const text = query.trim();
  return list
    .filter((a) => (text ? hasAll(`${a.label} ${a.keys}`, text) : a.main))
    .map((a) => ({ id: a.id, kind: 'action', icon: a.icon, label: a.label, meta: a.meta ?? 'action', run: a.run }));
}

function settingItems(query) {
  const text = query.trim();
  if (!text) return [];
  const instance = selectedInstance();
  const scope = instance ? 'instance' : 'global';
  const list = [
    { id: 's:ram', label: instance ? `Mémoire de ${instance.name}` : 'Mémoire', keys: 'memoire ram go allocation', run: () => openSettings(scope, 'ram') },
    { id: 's:java', label: instance ? `Java de ${instance.name}` : 'Java', keys: 'java runtime jvm', run: () => openSettings(scope, 'java-title') },
    { id: 's:launcher', label: 'Paramètres du launcher', keys: 'parametres launcher reglages theme accent', run: () => openSettings('launcher') },
    { id: 's:storage', label: 'Stockage', keys: 'stockage disque nettoyer espace java installes', run: () => openSettings('storage') },
  ];
  return list.filter((a) => hasAll(`${a.label} ${a.keys}`, text)).map((a) => ({ id: a.id, kind: 'setting', icon: 'settings', label: a.label, meta: 'réglage', run: a.run }));
}

/** Groupes affichés, dans l'ordre, sans les groupes vides. Chaque ligne reçoit un numéro à plat. */
export function paletteGroups(query = state.modal?.query ?? '') {
  const groups = [
    { id: 'instances', title: 'Instances', items: instanceItems(query) },
    { id: 'mods', title: 'Mods', items: modItems(query) },
    { id: 'actions', title: 'Actions', items: actionItems(query) },
    { id: 'settings', title: 'Réglages', items: settingItems(query) },
  ].filter((g) => g.items.length > 0);
  let index = 0;
  for (const group of groups) for (const item of group.items) item.index = index++;
  return groups;
}

export const paletteFlat = () => paletteGroups().flatMap((g) => g.items);

// ---------- Saisie et clavier ----------

export function setPaletteQuery(value) {
  update((s) => {
    if (s.modal?.type !== 'palette') return;
    s.modal.query = value;
    s.modal.active = 0;
    s.modal.reveal = true;
  });
  scheduleRemote();
}

export function setPaletteActive(index) {
  if (state.modal?.type !== 'palette' || state.modal.active === index) return;
  update((s) => { s.modal.active = index; });
}

export function paletteKey(e) {
  if (e.isComposing || state.modal?.type !== 'palette') return;
  const flat = paletteFlat();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (flat.length === 0) return;
    const step = e.key === 'ArrowDown' ? 1 : -1;
    update((s) => {
      s.modal.active = (Math.min(s.modal.active, flat.length - 1) + step + flat.length) % flat.length;
      s.modal.reveal = true;
    });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    flat[Math.min(state.modal.active, flat.length - 1)]?.run(e.shiftKey);
  }
}
