'use strict';

// Installe les dépendances qui manquent aux mods d'une instance, quelle que soit leur origine
// (fichier glissé, instance importée, ensemble de mods). Les jars annoncent un identifiant de mod,
// pas un projet Modrinth : chaque candidat est téléchargé, puis ouvert, et n'est gardé que s'il
// fournit vraiment l'identifiant demandé.
const { t } = require('../i18n');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { fetchBuffer, sha1 } = require('./download');
const content = require('./content');
const modCheck = require('./mod-check');
const modrinth = require('./modrinth');

const MAX_ROUNDS = 5; // une dépendance peut avoir ses propres dépendances
const MAX_SEARCH_TRIES = 4; // téléchargements d'essai par identifiant, hors projets connus
const NOT_FOUND_TTL_MS = 10 * 60 * 1000;

const ALIASES = { commonnetworking: 'common-network' }; // nom trop éloigné de l'identifiant pour la recherche

const notFound = new Map(); // identifiant|version|loader → date du dernier échec

const squash = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Fragments de Fabric API : l'identifiant vise un module livré dans le jar de Fabric API. */
const isFabricModule = (id) => id === 'fabric' || id.startsWith('fabric-');

/** Écritures probables du nom d'un mod : « yet_another_config_lib_v3 », « puzzleslib »… */
function queriesFor(id) {
  const words = id.replace(/[-_]v?\d+$/i, '').replace(/[-_]+/g, ' ').trim();
  return [...new Set([words, words.replace(/(?<=[a-z])(lib|api)$/i, ' $1'), id])];
}

/** Résultats de recherche, ceux dont le nom ressemble à l'identifiant d'abord. */
async function searchCandidates(id, search) {
  const key = squash(id);
  const seen = new Set();
  const hits = [];
  for (const query of queriesFor(id)) {
    const page = await modrinth.search({ query, limit: 10, ...search });
    for (const hit of page.hits) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      hits.push(hit);
    }
    if (hits.some((h) => squash(h.slug) === key)) break;
  }
  const close = (hit) => [hit.slug, hit.title].some((name) => {
    const value = squash(name);
    return value && (value.includes(key) || key.includes(value));
  });
  return [...hits.filter(close), ...hits.filter((h) => !close(h))].slice(0, MAX_SEARCH_TRIES).map((h) => h.id);
}

/** Projets à essayer pour un identifiant, du plus sûr au plus incertain. */
async function candidatesFor(id, context) {
  const { search, declared } = context;
  const projects = [...declared];
  if (ALIASES[id]) projects.push(ALIASES[id]);
  const direct = await modrinth.project(id).catch(() => null);
  if (direct?.projectType === 'mod') projects.push(direct.id);
  if (isFabricModule(id)) projects.push('fabric-api');
  try {
    projects.push(...(await searchCandidates(id, search)));
  } catch {
    context.offline = true; // les candidats déjà trouvés restent à essayer
  }
  return [...new Set(projects)];
}

/** Dépendances obligatoires annoncées par Modrinth pour les mods installés et encore absentes. */
async function declaredProjects({ gameDir, instance }) {
  const { items } = await content.listContent({ gameDir, kind: 'mods', instance });
  const installed = new Set(items.map((i) => i.projectId).filter(Boolean));
  const known = await modrinth.versionsByHash(items.filter((i) => i.enabled && i.sha1).map((i) => i.sha1));
  const declared = new Set();
  for (const version of Object.values(known)) {
    for (const dep of version.dependencies) {
      if (dep.dependency_type === 'required' && dep.project_id && !installed.has(dep.project_id)) declared.add(dep.project_id);
    }
  }
  return [...declared];
}

/** Télécharge la version compatible d'un projet et lit ce que son jar fournit, sans rien écrire. */
async function fetchCandidate(projectId, { loaders, gameVersion, cache }) {
  if (cache.has(projectId)) return cache.get(projectId);
  const version = modrinth.pickVersion(await modrinth.versions(projectId, { loaders, gameVersion }));
  let found = null;
  if (version?.file && version.file.filename.toLowerCase().endsWith('.jar')) {
    const data = await fetchBuffer(version.file.url);
    if (sha1(data) !== version.file.sha1) throw new Error(t('download.fichier_corrompu_sha', { path: version.file.filename }));
    found = { projectId: version.projectId, version, data, ...modCheck.jarIds(data, loaders[0]) };
  }
  cache.set(projectId, found);
  return found;
}

/** Cherche le projet qui fournit un identifiant. */
async function findProvider(id, context) {
  for (const projectId of await candidatesFor(id, context)) {
    const found = await fetchCandidate(projectId, context).catch(() => {
      context.offline = true;
      return null;
    });
    if (found?.ids.includes(id)) return found;
  }
  return null;
}

/**
 * Installe ce qui manque, dépendances des dépendances comprises, et remplace une dépendance
 * trop ancienne. Renvoie ce qui a été ajouté, ce qui reste introuvable et le diagnostic final.
 */
async function resolve({ gameDir, instance, trash, log = () => {} }) {
  const loaders = content.loadersFor('mods', instance);
  const installed = [];
  const unresolved = new Set();
  const handled = new Set();
  const dir = content.contentDir(gameDir, 'mods');
  const search = { projectType: 'mod', gameVersion: instance.version, loaders };
  const notFoundKey = (id) => `${id}|${instance.version}|${instance.loader}`;
  const cache = new Map();

  for (let round = 0; loaders.length && round < MAX_ROUNDS; round++) {
    const { problems } = await modCheck.check({ gameDir, instance });
    const wanted = problems.filter((p) => p.dependency && !handled.has(p.dependency.id));
    if (!wanted.length) break;

    const declared = await declaredProjects({ gameDir, instance }).catch(() => []);
    const context = { search, declared, loaders, gameVersion: instance.version, cache };
    for (const { dependency } of wanted) {
      const { id, outdated } = dependency;
      if (handled.has(id)) continue;
      handled.add(id);
      if (context.offline) continue; // Modrinth ne répond pas : la vérification avant lancement reste valable
      const failedAt = notFound.get(notFoundKey(id));
      if (failedAt && Date.now() - failedAt < NOT_FOUND_TTL_MS) {
        unresolved.add(id);
        continue;
      }

      const found = await findProvider(id, context);
      if (!found) {
        if (context.offline) continue;
        notFound.set(notFoundKey(id), Date.now());
        unresolved.add(id);
        continue;
      }
      const filename = path.basename(found.version.file.filename);
      if (filename === outdated) { // déjà la dernière version compatible
        unresolved.add(id);
        continue;
      }
      // Une version trop ancienne laisse place à la nouvelle ; un même jar peut régler plusieurs identifiants.
      for (const other of found.ids) handled.add(other);
      const target = path.join(dir, filename);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(target, found.data);
      if (outdated) await trash(path.join(dir, outdated));
      installed.push({ projectId: found.projectId, version: found.version.number, file: filename, dependency: true });
      log(t('content.installe', { filename }));
    }
  }

  const titles = await modrinth.projects(installed.map((d) => d.projectId)).catch(() => []);
  const titleOf = Object.fromEntries(titles.map((p) => [p.id, p.title]));
  const final = await modCheck.check({ gameDir, instance });
  const problems = final.problems.map((problem) => (
    problem.dependency && unresolved.has(problem.dependency.id)
      ? { ...problem, text: `${problem.text} ${t('mod_deps.introuvable', { version: instance.version, loader: instance.loader })}` }
      : problem
  ));
  return {
    installed: installed.map((d) => ({ ...d, title: titleOf[d.projectId] ?? d.file })),
    unresolved: [...unresolved],
    problems,
  };
}

module.exports = { resolve };
