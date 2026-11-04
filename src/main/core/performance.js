'use strict';

// Performances : arguments Java selon la version de Java, mémoire conseillée et Pack Performances (mods Modrinth).
const os = require('node:os');
const content = require('./content');
const modrinth = require('./modrinth');

const PRESETS = new Set(['auto', 'g1', 'zgc', 'none']);
// Une instance vanilla est montrée comme si elle passait en Fabric.
const LOADER_LABELS = { vanilla: 'Fabric', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };

// G1 réglé pour un jeu : pauses courtes et jeune génération plus grande (les objets du jeu vivent très peu).
const G1_ARGS = [
  '-XX:+UseG1GC',
  '-XX:MaxGCPauseMillis=37',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:G1NewSizePercent=23',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapRegionSize=16M',
  '-XX:+ParallelRefProcEnabled',
  '-XX:+DisableExplicitGC',
];
// Communs à G1 et ZGC : tas touché dès le démarrage (pas de défauts de page en jeu), pas de fichier de statistiques
// écrit sur le disque pendant les pauses.
const COMMON_ARGS = ['-XX:+AlwaysPreTouch', '-XX:+PerfDisableSharedMem'];
// En dessous, G1 fait mieux sur un client : ZGC prend du processeur au jeu et veut de la marge de mémoire.
const ZGC_MIN_CPUS = 8;
const ZGC_MIN_RAM = 6;

/** ZGC générationnel : option à passer en Java 21 ; c'est le mode par défaut (et unique) depuis Java 23. */
function zgcArgs(javaMajor) {
  if (javaMajor >= 25) return ['-XX:+UseZGC', '-XX:+UseCompactObjectHeaders'];
  if (javaMajor >= 23) return ['-XX:+UseZGC'];
  return ['-XX:+UseZGC', '-XX:+ZGenerational'];
}

/** L'utilisateur choisit déjà son ramasse-miettes dans ses propres arguments. */
function userChoosesGc(jvmArgs) {
  return /-XX:\+Use\w*GC\b/.test(jvmArgs ?? '');
}

/** Ramasse-miettes réellement utilisé : 'g1', 'zgc' ou 'none' (celui de Java par défaut). */
function resolveGc({ preset = 'auto', javaMajor, ramGb = 0, cpus = os.cpus().length, jvmArgs = '' }) {
  if (preset === 'none' || userChoosesGc(jvmArgs)) return 'none';
  // ZGC travaille en parallèle du jeu : il lui faut Java 21 (générationnel), assez de cœurs et un tas assez grand.
  const zgcOk = javaMajor >= 21;
  if (preset === 'zgc') return zgcOk ? 'zgc' : 'g1';
  if (preset === 'g1') return 'g1';
  return zgcOk && cpus >= ZGC_MIN_CPUS && ramGb >= ZGC_MIN_RAM ? 'zgc' : 'g1';
}

/** Arguments de mémoire et de ramasse-miettes, placés avant ceux de l'utilisateur (qui gardent le dernier mot). */
function jvmArguments({ preset = 'auto', javaMajor, ramGb, jvmArgs = '', cpus }) {
  const memory = Math.round(ramGb * 1024);
  const gc = resolveGc({ preset, javaMajor, ramGb, cpus, jvmArgs });
  if (preset === 'none') return { gc, args: [`-Xmx${memory}M`, `-Xms${Math.min(memory, 1024)}M`] };
  // Tas réservé d'un coup : pas d'agrandissements pendant la partie.
  const heap = [`-Xmx${memory}M`, `-Xms${memory}M`];
  if (gc === 'zgc') return { gc, args: [...heap, ...zgcArgs(javaMajor), ...COMMON_ARGS] };
  if (gc === 'g1') return { gc, args: [...heap, ...G1_ARGS, ...COMMON_ARGS] };
  return { gc, args: heap };
}

/** Mémoire conseillée en Go : base du loader, nombre de mods, marge si ZGC est imposé, au plus la moitié de la RAM. */
function recommendedRam({ loader = 'vanilla', mods = 0, zgc = false, totalGb = os.totalmem() / 1024 ** 3 }) {
  let gb = loader === 'vanilla' ? 3 : 4;
  if (mods > 50) gb = 6;
  if (mods > 120) gb = 8;
  if (mods > 200) gb = 10;
  if (zgc) gb += 1; // ZGC prend 10 à 15 % de mémoire en plus
  const cap = Math.max(2, Math.floor(totalGb / 2));
  return Math.min(gb, cap);
}

// ---------- Pack Performances ----------

/**
 * Mods proposés, dans l'ordre d'affichage. `modIds` sert à reconnaître un mod déjà présent (même sans Internet),
 * `conflicts` les mods qui font le même travail. `alt` : remplaçant quand le mod n'existe pas pour l'instance.
 */
const PACK = [
  { slug: 'sodium', title: 'Sodium', impact: 'fps', what: 'Nouveau moteur de rendu du monde : souvent 2 à 3 fois plus de FPS', modIds: ['sodium'], conflicts: ['embeddium', 'rubidium', 'optifine'], alt: 'embeddium' },
  { slug: 'embeddium', title: 'Embeddium', impact: 'fps', what: 'La version Forge de Sodium : même principe', modIds: ['embeddium'], conflicts: ['sodium', 'rubidium', 'optifine'], altOnly: true },
  { slug: 'entityculling', title: 'Entity Culling', impact: 'fps2', what: 'Ne dessine pas les entités et coffres cachés derrière les murs', modIds: ['entityculling'] },
  { slug: 'moreculling', title: 'More Culling', impact: 'fps2', what: 'Ne dessine pas les faces cachées des feuilles et des blocs', modIds: ['moreculling'], conflicts: ['optifine'] },
  { slug: 'immediatelyfast', title: 'ImmediatelyFast', impact: 'fps2', what: "Accélère l'interface, les textes, les cartes et les panneaux", modIds: ['immediatelyfast'] },
  { slug: 'lithium', title: 'Lithium', impact: 'tick', what: 'Accélère la logique du monde en solo (mobs, redstone, chunks)', modIds: ['lithium'], conflicts: ['canary', 'radium'] },
  { slug: 'ferrite-core', title: 'FerriteCore', impact: 'ram', what: 'Réduit la mémoire utilisée, donc moins de pauses', modIds: ['ferritecore'] },
  { slug: 'modernfix', title: 'ModernFix', impact: 'start', what: 'Démarrage plus rapide et moins de mémoire', modIds: ['modernfix'] },
  { slug: 'dynamic-fps', title: 'Dynamic FPS', impact: 'eco', what: "Baisse les FPS quand la fenêtre n'est pas active : PC plus frais", modIds: ['dynamic_fps', 'dynamicfps'] },
  { slug: 'c2me-fabric', title: 'C2ME (avancé)', impact: 'tick', what: 'Génère les chunks sur plusieurs cœurs. Décoché : quelques conflits connus', modIds: ['c2me'], optional: true },
];

/** Mods de l'instance, identifiés par leur fichier (sans Internet). */
async function installedMods(gameDir, instance) {
  const { items } = await content.listContent({ gameDir, kind: 'mods', instance, online: false });
  return items.map((i) => ({ modId: (i.modId ?? '').toLowerCase(), file: i.file.toLowerCase(), enabled: i.enabled }));
}

function findMod(installed, ids) {
  return installed.find((m) => ids.includes(m.modId) || (ids.includes('optifine') && m.file.includes('optifine')));
}

/** Loaders Modrinth à interroger. Une instance vanilla est montrée comme si elle passait en Fabric. */
function packLoaders(instance) {
  if (instance.loader === 'vanilla') return ['fabric'];
  return content.loadersFor('mods', instance);
}

/**
 * État du pack pour une instance : pour chaque mod, `state` = installed | available | unavailable | conflict,
 * et `checked` = proposé coché.
 */
async function packStatus({ gameDir, instance }) {
  const loaders = packLoaders(instance);
  const installed = instance.loader === 'vanilla' ? [] : await installedMods(gameDir, instance);
  const versions = await Promise.all(
    PACK.map(async (mod) => {
      try {
        return modrinth.pickVersion(await modrinth.versions(mod.slug, { loaders, gameVersion: instance.version }));
      } catch {
        return null;
      }
    }),
  );
  const found = Object.fromEntries(PACK.map((mod, i) => [mod.slug, versions[i]]));

  const rows = [];
  for (const mod of PACK) {
    // Embeddium n'apparaît qu'à la place de Sodium.
    if (mod.altOnly && (found.sodium || !found[mod.slug])) continue;
    if (mod.alt && !found[mod.slug] && found[mod.alt]) continue;
    const present = findMod(installed, mod.modIds);
    const rival = mod.conflicts && findMod(installed, mod.conflicts);
    let state = 'available';
    let note = null;
    if (present) {
      state = 'installed';
      note = present.enabled ? 'Déjà installé' : 'Installé mais désactivé';
    } else if (rival) {
      state = 'conflict';
      note = `${rival.modId === 'optifine' || rival.file.includes('optifine') ? 'OptiFine' : rival.modId} fait déjà ce travail`;
    } else if (!found[mod.slug]) {
      state = 'unavailable';
      note = `Pas de version pour ${LOADER_LABELS[instance.loader]} ${instance.version}`;
    }
    rows.push({ slug: mod.slug, title: mod.title, what: mod.what, impact: mod.impact, state, note, checked: state === 'available' && !mod.optional, version: found[mod.slug]?.number ?? null });
  }
  return { loader: instance.loader, version: instance.version, mods: rows };
}

/** Installe les mods choisis (avec leurs dépendances), un par un. Un échec n'arrête pas les suivants. */
async function installPack({ gameDir, instance, slugs, trash, onProgress = () => {} }) {
  const allowed = new Set(PACK.map((m) => m.slug));
  const chosen = slugs.filter((s) => allowed.has(s));
  const installed = [];
  const failed = [];
  for (const [index, slug] of chosen.entries()) {
    onProgress({ done: index, total: chosen.length });
    try {
      const result = await content.install({ gameDir, kind: 'mods', instance, projectId: slug, trash });
      // Le mod demandé est désigné par son slug : on lui donne son nom du pack.
      const title = PACK.find((m) => m.slug === slug).title;
      installed.push(...result.installed.map((m) => (m.dependency ? m : { ...m, title })));
    } catch (error) {
      failed.push({ slug, title: PACK.find((m) => m.slug === slug).title, message: error.message });
    }
  }
  onProgress({ done: chosen.length, total: chosen.length });
  return { installed, failed };
}

/** Nombre de mods du pack déjà présents (pour la carte des paramètres de l'instance). */
async function packInstalledCount({ gameDir, instance }) {
  if (instance.loader === 'vanilla') return { installed: 0, mods: 0 };
  const installed = await installedMods(gameDir, instance);
  const count = PACK.filter((m) => !m.altOnly && findMod(installed, [...m.modIds, ...(m.alt ? PACK.find((x) => x.slug === m.alt).modIds : [])])).length;
  return { installed: count, mods: installed.filter((m) => m.enabled).length };
}

module.exports = { PRESETS, G1_ARGS, COMMON_ARGS, ZGC_MIN_CPUS, ZGC_MIN_RAM, zgcArgs, userChoosesGc, resolveGc, jvmArguments, recommendedRam, PACK, packStatus, installPack, packInstalledCount };
