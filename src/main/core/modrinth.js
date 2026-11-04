'use strict';

// Client de l'API Modrinth v2 (sans clé) : https://docs.modrinth.com/api/
const API = 'https://api.modrinth.com/v2';
const USER_AGENT = '0Rzxn_Launcher/0.1 (launcher Minecraft personnel)';
const TIMEOUT_MS = 20_000;

async function call(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Modrinth ne répond pas (${error.cause?.code ?? error.message}).`);
  }
  if (res.status === 404) return null;
  if (res.status === 429) throw new Error('Trop de requêtes vers Modrinth : réessaie dans une minute.');
  if (!res.ok) throw new Error(`Modrinth a répondu ${res.status}.`);
  return res.json();
}

const q = (value) => encodeURIComponent(JSON.stringify(value));

const SORTS = new Set(['relevance', 'downloads', 'follows', 'newest', 'updated']);

/** Recherche filtrée par type, version de Minecraft et loaders compatibles. */
async function search({ query = '', projectType, gameVersion, loaders = [], sort = 'relevance', offset = 0, limit = 20 }) {
  const facets = [[`project_type:${projectType}`]];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (loaders.length && projectType === 'mod') facets.push(loaders.map((l) => `categories:${l}`));
  const params = `query=${encodeURIComponent(query)}&facets=${q(facets)}&index=${SORTS.has(sort) ? sort : 'relevance'}&offset=${Math.max(0, offset | 0)}&limit=${Math.min(50, Math.max(1, limit | 0))}`;
  const data = await call(`/search?${params}`);
  return {
    total: data.total_hits,
    offset: data.offset,
    hits: data.hits.map((h) => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      author: h.author,
      icon: h.icon_url || null,
      downloads: h.downloads,
      follows: h.follows,
      categories: h.display_categories ?? h.categories,
      updated: h.date_modified,
      projectType: h.project_type,
    })),
  };
}

async function project(id) {
  const p = await call(`/project/${encodeURIComponent(id)}`);
  if (!p) throw new Error('Projet introuvable sur Modrinth.');
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description,
    icon: p.icon_url || null,
    downloads: p.downloads,
    follows: p.followers,
    categories: p.categories,
    projectType: p.project_type,
    license: p.license?.name ?? p.license?.id ?? null,
    updated: p.updated,
    gallery: (p.gallery ?? []).sort((a, b) => (b.featured - a.featured) || a.ordering - b.ordering).map((g) => ({ url: g.url, title: g.title })),
    links: { source: p.source_url, issues: p.issues_url, wiki: p.wiki_url, discord: p.discord_url },
  };
}

function simplifyVersion(v) {
  const file = v.files.find((f) => f.primary) ?? v.files[0];
  return {
    id: v.id,
    projectId: v.project_id,
    name: v.name,
    number: v.version_number,
    type: v.version_type,
    published: v.date_published,
    loaders: v.loaders,
    gameVersions: v.game_versions,
    dependencies: v.dependencies ?? [],
    file: file && { url: file.url, filename: file.filename, sha1: file.hashes.sha1, size: file.size },
    files: v.files.map((f) => ({ url: f.url, filename: f.filename, sha1: f.hashes.sha1, sha512: f.hashes.sha512, size: f.size })),
  };
}

/** Versions compatibles (les plus récentes d'abord). */
async function versions(projectId, { loaders, gameVersion }) {
  const params = [];
  if (loaders?.length) params.push(`loaders=${q(loaders)}`);
  if (gameVersion) params.push(`game_versions=${q([gameVersion])}`);
  const list = (await call(`/project/${encodeURIComponent(projectId)}/version?${params.join('&')}`)) ?? [];
  return list.map(simplifyVersion);
}

async function version(versionId) {
  const v = await call(`/version/${encodeURIComponent(versionId)}`);
  if (!v) throw new Error('Version introuvable sur Modrinth.');
  return simplifyVersion(v);
}

/** Retrouve les versions Modrinth correspondant à des fichiers (par empreinte SHA-1). */
async function versionsByHash(hashes) {
  if (!hashes.length) return {};
  const data = (await call('/version_files', { method: 'POST', body: { hashes, algorithm: 'sha1' } })) ?? {};
  return Object.fromEntries(Object.entries(data).map(([hash, v]) => [hash, simplifyVersion(v)]));
}

/** Dernière version compatible pour chaque fichier. */
async function latestByHash(hashes, { loaders, gameVersion }) {
  if (!hashes.length) return {};
  const body = { hashes, algorithm: 'sha1', loaders, game_versions: [gameVersion] };
  const data = (await call('/version_files/update', { method: 'POST', body })) ?? {};
  return Object.fromEntries(Object.entries(data).map(([hash, v]) => [hash, simplifyVersion(v)]));
}

async function projects(ids) {
  if (!ids.length) return [];
  const list = (await call(`/projects?ids=${q(ids)}`)) ?? [];
  return list.map((p) => ({ id: p.id, slug: p.slug, title: p.title, icon: p.icon_url || null, projectType: p.project_type }));
}

/** Préfère la dernière version stable, sinon la plus récente (ex. mods encore en bêta pour une nouvelle version). */
function pickVersion(list) {
  return list.find((v) => v.type === 'release') ?? list[0] ?? null;
}

module.exports = { search, project, versions, version, versionsByHash, latestByHash, projects, pickVersion };
