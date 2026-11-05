'use strict';

// Profils prêts à jouer de l'assistant de création : une seule table (loader, mods Modrinth, mémoire).
// Aucun mod qui donne un avantage interdit sur les serveurs : seulement du rendu, de l'affichage et du confort.
const content = require('./content');
const modrinth = require('./modrinth');
const performance = require('./performance');

// Mods du Pack Performances proposés par défaut sur Fabric (hors option avancée et hors variante Forge).
const PERF_ALL = performance.PACK.filter((m) => !m.optional && !m.altOnly).map((m) => m.slug);
const PERF_PVP = ['sodium', 'entityculling', 'immediatelyfast', 'ferrite-core', 'modernfix'];

const TITLES = {
  ...Object.fromEntries(performance.PACK.map((m) => [m.slug, m.title])),
  iris: 'Iris Shaders',
  'sodium-extra': 'Sodium Extra',
  zoomify: 'Zoomify',
  appleskin: 'AppleSkin',
  betterf3: 'BetterF3',
  'better-ping-display-fabric': 'Better Ping Display',
};

/**
 * `mods` : slugs Modrinth installés dans l'ordre. `required` : sans eux la version ne convient pas au profil
 * (on cherche alors une version plus ancienne). `shaders` : ajoute de la mémoire au conseil.
 */
const PROFILES = {
  survival: { id: 'survival', title: 'Survie optimisée', loader: 'fabric', mods: PERF_ALL, required: ['sodium'] },
  pvp: {
    id: 'pvp',
    title: 'PvP',
    loader: 'fabric',
    mods: [...PERF_PVP, 'sodium-extra', 'zoomify', 'appleskin', 'betterf3', 'better-ping-display-fabric'],
    required: ['sodium'],
  },
  shaders: { id: 'shaders', title: 'Shaders', loader: 'fabric', mods: ['sodium', 'iris'], required: ['sodium', 'iris'], shaders: true },
  creative: { id: 'creative', title: 'Créatif', loader: 'vanilla', mods: [], required: [] },
};

function profile(id) {
  const p = PROFILES[id];
  if (!p) throw new Error('Profil inconnu.');
  return p;
}

const titleOf = (slug) => TITLES[slug] ?? slug;

/** Disponibilité de chaque mod pour une version de Minecraft (lecture publique de Modrinth, en parallèle). */
async function modsFor(p, version) {
  if (!p.mods.length) return [];
  return Promise.all(
    p.mods.map(async (slug) => {
      let found = null;
      try {
        found = modrinth.pickVersion(await modrinth.versions(slug, { loaders: [p.loader], gameVersion: version }));
      } catch {
        found = null;
      }
      return { slug, title: titleOf(slug), available: Boolean(found), number: found?.number ?? null, required: p.required.includes(slug) };
    }),
  );
}

/**
 * Version et mods prévus. Sans version demandée : la dernière release, ou la plus récente (parmi quelques-unes)
 * où tous les mods indispensables du profil existent.
 */
async function plan({ profileId, version, releases, hasLoader }) {
  const p = profile(profileId);
  const latest = releases[0];
  if (version) {
    const mods = p.mods.length && (await hasLoader(version)) ? await modsFor(p, version) : await modsFor(p, version).then((m) => m.map((x) => ({ ...x, available: false })));
    return { profile: p.id, loader: p.loader, version, mods, shaders: Boolean(p.shaders) };
  }
  if (!p.mods.length) return { profile: p.id, loader: p.loader, version: latest, mods: [], shaders: false };
  let first = null;
  for (const candidate of releases.slice(0, 6)) {
    const ok = await hasLoader(candidate);
    const mods = ok ? await modsFor(p, candidate) : (await modsFor(p, candidate)).map((x) => ({ ...x, available: false }));
    const result = { profile: p.id, loader: p.loader, version: candidate, mods, shaders: Boolean(p.shaders) };
    first ??= result;
    if (ok && p.required.every((slug) => mods.find((m) => m.slug === slug)?.available)) return result;
  }
  return first;
}

/**
 * Installe les mods du profil un par un (dépendances comprises). Un mod sans version pour cette instance est
 * ignoré (`skipped`), toute autre erreur va dans `failed` ; rien n'arrête les suivants.
 */
async function installMods({ profileId, gameDir, instance, trash, onProgress = () => {} }) {
  const p = profile(profileId);
  const installed = [];
  const skipped = [];
  const failed = [];
  for (const [index, slug] of p.mods.entries()) {
    onProgress({ done: index, total: p.mods.length });
    try {
      const result = await content.install({ gameDir, kind: 'mods', instance, projectId: slug, trash });
      installed.push(...result.installed.map((m) => (m.dependency ? m : { ...m, title: titleOf(slug) })));
    } catch (error) {
      if (/^Aucune version compatible/.test(error.message)) skipped.push({ slug, title: titleOf(slug) });
      else failed.push({ slug, title: titleOf(slug), message: error.message });
    }
  }
  onProgress({ done: p.mods.length, total: p.mods.length });
  return { installed, skipped, failed };
}

/** Table pour l'interface : le titre et le loader suffisent, le reste est calculé par `plan`. */
function list() {
  return Object.values(PROFILES).map((p) => ({ id: p.id, title: p.title, loader: p.loader, mods: p.mods.length }));
}

module.exports = { PROFILES, profile, plan, installMods, list };
