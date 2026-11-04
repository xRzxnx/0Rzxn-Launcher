'use strict';

// Rapports de crash : rapports du jeu (crash-reports), plantages de Java (hs_err_pid*.log) et logs
// gardés par le launcher quand le jeu s'arrête sur une erreur. Chaque rapport est expliqué en français
// quand l'erreur est connue, et peut être partagé sur mclo.gs.
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const LOG_DIR = 'crash-logs';
const KEEP_LOGS = 15;
const MAX_TEXT = 4 * 1024 * 1024;

// ---------- Fichiers ----------

/** Les trois sources, avec la règle de nom qui les protège des chemins arbitraires. */
const SOURCES = {
  report: { dir: ({ gameDir }) => path.join(gameDir, 'crash-reports'), name: /^crash-.+\.txt$/i, kind: 'Crash du jeu' },
  jvm: { dir: ({ gameDir }) => gameDir, name: /^hs_err_pid\d+\.log$/i, kind: 'Crash de Java' },
  log: { dir: ({ instanceDir }) => path.join(instanceDir, LOG_DIR), name: /^launcher-[\d_-]+\.log$/i, kind: 'Arrêt anormal' },
};

function crashFile(dirs, source, file) {
  const def = SOURCES[source];
  if (!def || typeof file !== 'string' || file !== path.basename(file) || !def.name.test(file)) throw new Error('Rapport invalide.');
  return path.join(def.dir(dirs), file);
}

async function listCrashes(dirs) {
  const found = [];
  for (const [source, def] of Object.entries(SOURCES)) {
    let names = [];
    try {
      names = (await fsp.readdir(def.dir(dirs))).filter((n) => def.name.test(n));
    } catch {
      continue;
    }
    for (const file of names) {
      const stat = await fsp.stat(path.join(def.dir(dirs), file)).catch(() => null);
      if (stat?.isFile()) found.push({ source, file, kind: def.kind, at: stat.mtimeMs, size: stat.size });
    }
  }
  return found.sort((a, b) => b.at - a.at);
}

async function readCrashText(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    // Un log énorme : on garde la fin, là où se trouve l'erreur.
    const start = Math.max(0, size - MAX_TEXT);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return { text: buffer.toString('utf8'), truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

const pad = (n) => String(n).padStart(2, '0');

/** Le jeu s'est arrêté sur une erreur sans rapport du jeu : on garde ses derniers logs (déjà censurés). */
async function saveCrashLog(instanceDir, lines, { code } = {}) {
  const dir = path.join(instanceDir, LOG_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const d = new Date();
  const file = `launcher-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.log`;
  const body = lines.map((l) => `[${l.time}] [${l.tag}]: ${l.msg}`).join('\n');
  await fsp.writeFile(path.join(dir, file), `${body}\n[0Rzxn_ Launcher] Jeu fermé avec le code de sortie ${code}\n`);
  const old = (await fsp.readdir(dir)).filter((n) => SOURCES.log.name.test(n)).sort().slice(0, -KEEP_LOGS);
  await Promise.all(old.map((n) => fsp.rm(path.join(dir, n), { force: true })));
  return file;
}

// ---------- Explications ----------

// Identifiant de mod → projet Modrinth, quand ils diffèrent.
const MODRINTH_SLUGS = {
  fabric: 'fabric-api',
  fabric_api: 'fabric-api',
  'fabric-api-base': 'fabric-api',
  cloth_config: 'cloth-config',
  architectury: 'architectury-api',
  yet_another_config_lib_v3: 'yacl',
  'yet-another-config-lib': 'yacl',
  owo: 'owo-lib',
  forgeconfigapiport: 'forge-config-api-port',
  kotlinforforge: 'kotlin-for-forge',
  puzzleslib: 'puzzles-lib',
};
// Noms affichés des dépendances les plus courantes (les rapports Forge ne donnent que l'identifiant).
const KNOWN_NAMES = {
  fabric: 'Fabric API',
  'fabric-api': 'Fabric API',
  fabric_api: 'Fabric API',
  'fabric-language-kotlin': 'Fabric Language Kotlin',
  sodium: 'Sodium',
  'cloth-config': 'Cloth Config',
  cloth_config: 'Cloth Config',
  architectury: 'Architectury API',
  geckolib: 'GeckoLib',
  modmenu: 'Mod Menu',
  yet_another_config_lib_v3: 'YetAnotherConfigLib',
  kotlinforforge: 'Kotlin for Forge',
  forgeconfigapiport: 'Forge Config API Port',
  balm: 'Balm',
  owo: 'oωo',
};
const BUILTIN = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'forge', 'neoforge', 'fml', 'javafml']);
const slugOf = (id) => MODRINTH_SLUGS[id] ?? id.replace(/_/g, '-');
const javaOfClass = (version) => Number(version) - 44;

const GPU_DLLS = [
  [/^(atio6axx|atioglxx|atig6pxx|atig6txx|amdxc64|amdxx64)/i, 'AMD'],
  [/^nvoglv/i, 'NVIDIA'],
  [/^ig\w*icd/i, 'Intel'],
  [/^opengl32/i, null],
];

const DEP = String.raw`(?:mod )?(?:'([^']+)' \(([^)]+)\)|([\w.-]+))`;
const FABRIC_REQUIRES = new RegExp(String.raw`Mod '([^']+)' \(([^)]+)\) (\S+) requires (.+?) of ${DEP}, (which is missing|but only the wrong version is present: ([^!\s]+))`);
const FABRIC_BREAKS = new RegExp(String.raw`Mod '([^']+)' \(([^)]+)\) (\S+) is incompatible with (.+?) of ${DEP}`);
const FORGE_DEP = /Mod ID: '([\w.-]+)', Requested by: '([\w.-]+)', Expected range: '([^']*)', Actual version: '([^']*)'/;

/**
 * Explique un rapport. context : { java (version utilisée), ram (Go), javaMode ('auto' | 'custom') }.
 * Renvoie { problems: [{ id, label, title, text, advice, actions, lines }], suspects }.
 */
function diagnose(text, context = {}) {
  const lines = text.split(/\r?\n/);
  const problems = new Map();
  const add = (key, problem, line) => {
    const known = problems.get(key);
    if (known) {
      if (line != null && !known.lines.includes(line)) known.lines.push(line);
      return;
    }
    problems.set(key, { actions: [], ...problem, lines: line == null ? [] : [line] });
  };
  const javaProblem = (need, have, line) => {
    const usingCustom = context.javaMode === 'custom';
    add('java', {
      id: 'java',
      label: 'Java incompatible',
      title: need ? `Il faut Java ${need}${have ? `, pas Java ${have}` : ''}` : 'Cette version de Java ne convient pas',
      text: `Minecraft ou un de ses mods a été compilé pour ${need ? `Java ${need}` : 'une autre version de Java'}${have ? `, mais le jeu a démarré avec Java ${have}` : ''}. Java refuse alors de charger le code.`,
      advice: usingCustom
        ? 'Ton instance utilise un Java personnalisé : repasse en Java automatique, le launcher téléchargera le bon.'
        : 'Si un seul mod demande ce Java, il est fait pour une autre version de Minecraft : prends la version du mod qui correspond à ton instance.',
      actions: usingCustom ? [{ type: 'settings', label: 'Ouvrir les réglages Java' }] : [{ type: 'mods', label: "Ouvrir l'onglet Mods" }],
    }, line);
  };
  const missing = (requester, depId, rawName, range, line) => {
    if (depId === 'java') return javaProblem(String(range).match(/\d+/)?.[0], context.java, line);
    if (BUILTIN.has(depId)) return;
    const depName = rawName ?? KNOWN_NAMES[depId] ?? null;
    add(`missing:${depId}`, {
      id: 'missing',
      label: 'Mod manquant',
      title: `${requester.name} a besoin de ${depName ?? depId}, qui n'est pas installé`,
      text: `Le loader vérifie les dépendances avant de démarrer : ${requester.name}${requester.version ? ` ${requester.version}` : ''} demande ${depName ?? depId}${range && range !== 'any version' ? ` (${range})` : ''}. Le jeu s'arrête avant le menu.`,
      advice: `Installe ${depName ?? depId} pour cette version de Minecraft, ou désactive ${requester.name}.`,
      actions: [
        { type: 'install', slug: slugOf(depId), label: `Installer ${depName ?? depId}` },
        requester.id && { type: 'disable', modId: requester.id, label: `Désactiver ${requester.name}` },
      ].filter(Boolean),
    }, line);
  };
  const wrongVersion = (requester, depId, depName, rawRange, present, line) => {
    // « version 1.21.4 » (Fabric) ou « [1.20.4] » (Forge) : on garde le numéro seul.
    const range = String(rawRange ?? '').replace(/^versions? /, '').replace(/^\[([^,\]]+)\]$/, '$1');
    if (depId === 'java') return javaProblem(String(range).match(/\d+/)?.[0], present?.match(/^\d+/)?.[0], line);
    const isGame = depId === 'minecraft';
    add(`version:${requester.id}:${depId}`, {
      id: 'version',
      label: isGame ? 'Mod pour une autre version' : 'Mauvaise version de dépendance',
      title: isGame ? `${requester.name} est fait pour Minecraft ${range}` : `${requester.name} demande une autre version de ${depName ?? depId}`,
      text: `${requester.name}${requester.version ? ` ${requester.version}` : ''} demande ${depName ?? depId} ${range}, mais la version installée est ${present}.`,
      advice: isGame
        ? `Remplace ${requester.name} par sa version pour Minecraft ${present}, ou désactive-le.`
        : `Mets à jour ${depName ?? depId} ou ${requester.name} depuis l'onglet Mods.`,
      actions: [{ type: 'disable', modId: requester.id, label: `Désactiver ${requester.name}` }, { type: 'mods', label: "Ouvrir l'onglet Mods" }],
    }, line);
  };

  let jvmFrame = null;
  let accessViolation = false;
  lines.forEach((line, i) => {
    let m;
    if ((m = FABRIC_REQUIRES.exec(line))) {
      const requester = { name: m[1], id: m[2], version: m[3] };
      const depId = m[6] ?? m[7];
      if (m[8] === 'which is missing') missing(requester, depId, m[5], m[4], i);
      else wrongVersion(requester, depId, m[5], m[4], m[9], i);
    } else if ((m = FABRIC_BREAKS.exec(line))) {
      const other = m[5] ?? m[6] ?? m[7];
      add(`breaks:${m[2]}:${other}`, {
        id: 'incompatible',
        label: 'Mods incompatibles',
        title: `${m[1]} ne fonctionne pas avec ${other}`,
        text: `${m[1]} déclare être incompatible avec ${other} : les deux ne peuvent pas être installés ensemble.`,
        advice: `Désactive l'un des deux.`,
        actions: [{ type: 'disable', modId: m[2], label: `Désactiver ${m[1]}` }],
      }, i);
    } else if ((m = FORGE_DEP.exec(line))) {
      const requester = { name: m[2], id: m[2] };
      if (m[4] === '[MISSING]') missing(requester, m[1], null, m[3], i);
      else wrongVersion(requester, m[1], null, m[3], m[4], i);
    } else if ((m = /UnsupportedClassVersionError.*?class file version (\d+)(?:\.\d+)?\).*?up to (\d+)(?:\.\d+)?/.exec(line))) {
      javaProblem(javaOfClass(m[1]), javaOfClass(m[2]), i);
    } else if (/AppClassLoader cannot be cast to (?:class )?java\.net\.URLClassLoader/.test(line)) {
      javaProblem(8, context.java, i);
    } else if (/NoClassDefFoundError: net\/fabricmc\/fabric\/api|ClassNotFoundException: net\.fabricmc\.fabric\.api/.test(line)) {
      missing({ name: 'Un mod' }, 'fabric-api', 'Fabric API', null, i);
    } else if ((m = /java\.lang\.OutOfMemoryError(?:: (.+))?/.exec(line))) {
      add('memory', {
        id: 'memory',
        label: 'Mémoire insuffisante',
        title: 'Le jeu a manqué de mémoire',
        text: `Java a utilisé toute la mémoire allouée${context.ram ? ` (${String(context.ram).replace('.', ',')} Go)` : ''}${m[1] ? ` : « ${m[1].trim()} »` : ''}. C'est fréquent avec beaucoup de mods ou de gros packs de ressources.`,
        advice: 'Donne plus de mémoire à l’instance (6 à 8 Go suffisent pour la plupart des modpacks), sans dépasser la moitié de la RAM de ton PC.',
        actions: [{ type: 'settings', label: 'Changer la mémoire' }],
      }, i);
    } else if (/Could not reserve enough space for .*object heap|Invalid maximum heap size/.test(line)) {
      add('reserve', {
        id: 'memory',
        label: 'Mémoire insuffisante',
        title: 'Java n’a pas pu réserver la mémoire demandée',
        text: `La mémoire demandée${context.ram ? ` (${String(context.ram).replace('.', ',')} Go)` : ''} n'est pas disponible : trop de programmes ouverts, ou un Java 32 bits limité à environ 1,5 Go.`,
        advice: 'Baisse la mémoire de l’instance ou ferme des programmes. Avec un Java personnalisé, vérifie qu’il est en 64 bits.',
        actions: [{ type: 'settings', label: 'Changer la mémoire' }],
      }, i);
    } else if (/There is insufficient memory for the Java Runtime Environment/.test(line)) {
      add('native-memory', {
        id: 'memory',
        label: 'Mémoire insuffisante',
        title: 'Ton PC n’avait plus assez de mémoire libre',
        text: 'Java a demandé de la mémoire à Windows, qui n’en avait plus. Ce n’est pas la mémoire allouée au jeu qui manque, mais celle du PC.',
        advice: 'Ferme des programmes (navigateur, autres jeux), ou baisse un peu la mémoire de l’instance pour laisser de la place à Windows.',
        actions: [{ type: 'settings', label: 'Changer la mémoire' }],
      }, i);
    } else if (/Pixel format not accelerated|GLFW error 65542|WGL: The driver does not appear to support OpenGL|No OpenGL context found/i.test(line)) {
      add('gpu', gpuProblem(null), i);
    } else if ((m = /Mixin apply(?: for mod ([\w.-]+))? failed:? ?([\w.-]+\.json)?/.exec(line)) || (m = /(?:MixinApplyError|InvalidInjectionException|InvalidMixinException|MixinTransformerError).*?([\w-]+)\.mixins?\.json/.exec(line))) {
      const mod = m[1] && !m[1].endsWith('.json') ? m[1] : (m[2] ?? m[1] ?? '').replace(/(\.client|\.common)?\.mixins?\.json$/, '') || null;
      add(`mixin:${mod}`, {
        id: 'mixin',
        label: 'Mod incompatible',
        title: mod ? `${mod} n'a pas pu modifier le jeu` : "Un mod n'a pas pu modifier le jeu",
        text: `Les mods Fabric et NeoForge modifient le code du jeu avec Mixin. ${mod ? `Celui de ${mod}` : 'Un de ces correctifs'} ne s'applique pas : le mod est fait pour une autre version, ou un autre mod modifie le même endroit.`,
        advice: mod ? `Mets ${mod} à jour, ou désactive-le pour vérifier que c'est lui.` : 'Mets tes mods à jour depuis l’onglet Mods.',
        actions: [mod && { type: 'disable', modId: mod, label: `Désactiver ${mod}` }, { type: 'mods', label: "Ouvrir l'onglet Mods" }].filter(Boolean),
      }, i);
    } else if (/java\.util\.zip\.ZipException|zip END header not found|invalid LOC header|error in opening zip file|ZipError/.test(line)) {
      const jar = /([\w.+-]+\.jar)/.exec(line)?.[1] ?? /([\w.+-]+\.jar)/.exec(lines[i + 1] ?? '')?.[1] ?? null;
      add('corrupt', {
        id: 'corrupt',
        label: 'Fichier abîmé',
        title: jar ? `Le fichier ${jar} est abîmé` : 'Un fichier .jar est abîmé',
        text: 'Java n’arrive pas à ouvrir une archive : téléchargement interrompu, ou fichier modifié.',
        advice: jar ? `Supprime ${jar} et réinstalle-le, puis lance « Vérifier à nouveau » sur l’accueil.` : 'Lance « Vérifier à nouveau » sur l’accueil pour retélécharger les fichiers du jeu.',
        actions: [{ type: 'verify', label: 'Vérifier les fichiers' }],
      }, i);
    } else if (/Java HotSpot\(TM\) Client VM|JVM is 32-bit|32-bit Java/i.test(line)) {
      add('java32', {
        id: 'java32',
        label: 'Java 32 bits',
        title: 'Le jeu tourne avec un Java 32 bits',
        text: 'Un Java 32 bits ne peut pas utiliser plus d’environ 1,5 Go de mémoire, et les versions récentes de Minecraft ne le prennent plus en charge.',
        advice: 'Repasse en Java automatique : le launcher utilise le Java 64 bits de Mojang.',
        actions: [{ type: 'settings', label: 'Ouvrir les réglages Java' }],
      }, i);
    } else if (/EXCEPTION_ACCESS_VIOLATION/.test(line)) {
      accessViolation = true;
    } else if ((m = /^#\s+C\s+\[([\w.-]+\.dll)\+/i.exec(line))) {
      jvmFrame = { dll: m[1], line: i };
    }
  });
  if (accessViolation && jvmFrame) {
    const vendor = GPU_DLLS.find(([re]) => re.test(jvmFrame.dll));
    if (vendor) add('gpu', gpuProblem(vendor[1], jvmFrame.dll), jvmFrame.line);
  }

  const suspects = suspectedMods(lines);
  const list = [...problems.values()];
  if (!list.length) list.push(unknownProblem(lines, suspects));
  return { problems: list, suspects };
}

function gpuProblem(vendor, dll) {
  return {
    id: 'gpu',
    label: 'Pilote graphique',
    title: vendor ? `Le pilote graphique ${vendor} a planté` : 'Le pilote graphique ne convient pas',
    text: dll
      ? `Java s'est arrêté dans ${dll}, un fichier du pilote de ta carte graphique. Ce n'est en général ni Minecraft ni un mod.`
      : "Le jeu n'a pas pu ouvrir une fenêtre OpenGL : le pilote de la carte graphique est trop ancien ou c'est le pilote de base de Windows.",
    advice: `Mets à jour le pilote ${vendor ?? 'de ta carte graphique'} depuis le site du fabricant${vendor === 'NVIDIA' ? ' (GeForce Experience ou nvidia.com)' : vendor === 'AMD' ? ' (AMD Software ou amd.com)' : vendor === 'Intel' ? ' (intel.com)' : ''}. Avec les shaders, essaie aussi sans.`,
    actions: [],
  };
}

/** « Suspected Mods: Sodium (sodium), Iris (iris) » dans les rapports du jeu. */
function suspectedMods(lines) {
  const at = lines.findIndex((l) => /Suspected Mods?:/.test(l));
  if (at < 0) return [];
  const rest = lines[at].split(/Suspected Mods?:/)[1].trim();
  const text = rest || (lines[at + 1] ?? '').trim();
  if (!text || /^(NONE|Unknown|~~ERROR~~)/i.test(text)) return [];
  return [...text.matchAll(/([^,()]+?) \(([\w.-]+)\)/g)].map((m) => ({ name: m[1].trim(), modId: m[2] })).slice(0, 5);
}

function unknownProblem(lines, suspects) {
  const descriptionAt = lines.findIndex((l) => /^Description: /.test(l));
  const errorAt = lines.findIndex((l) => /^\S*(Exception|Error)\b.*?:|^Caused by: /.test(l.trim()));
  const error = errorAt >= 0 ? lines[errorAt].trim().slice(0, 200) : null;
  if (suspects.length) {
    const names = suspects.map((s) => s.name).join(', ');
    return {
      id: 'suspect',
      label: 'Mod en cause',
      title: `Le plantage vient sans doute de ${names}`,
      text: `Le rapport du jeu désigne ${suspects.length > 1 ? 'ces mods' : 'ce mod'}${error ? ` après l'erreur « ${error} »` : ''}.`,
      advice: `Mets ${suspects.length > 1 ? 'ces mods' : 'ce mod'} à jour ou désactive-${suspects.length > 1 ? 'les' : 'le'} pour vérifier.`,
      actions: suspects.slice(0, 2).map((s) => ({ type: 'disable', modId: s.modId, label: `Désactiver ${s.name}` })),
      lines: [errorAt, descriptionAt].filter((n) => n >= 0),
    };
  }
  return {
    id: 'unknown',
    label: 'Erreur inconnue',
    title: 'Le launcher ne reconnaît pas cette erreur',
    text: error ? `Le jeu s'est arrêté sur « ${error} ».` : "Le jeu s'est arrêté sans message connu.",
    advice: 'Partage le rapport sur mclo.gs et envoie le lien à la personne qui t’aide : il contient tout ce qu’il faut pour trouver la cause.',
    actions: [],
    lines: [errorAt, descriptionAt].filter((n) => n >= 0),
  };
}

// ---------- Partage ----------

/** Retire ce qui identifie l'utilisateur avant l'envoi : nom de session Windows, jetons. */
function scrub(text) {
  let out = text.replace(/(--accessToken|--uuid|--xuid|--clientId)(\s+)\S+/g, '$1$2••••••••').replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, '••••••••');
  const user = os.userInfo().username;
  if (user && user.length >= 3) out = out.split(`\\Users\\${user}`).join('\\Users\\<utilisateur>').split(`/Users/${user}`).join('/Users/<utilisateur>');
  return out;
}

/** Envoie le texte sur mclo.gs (25 000 lignes et 10 Mo au plus) ; renvoie { url, id }. */
async function shareLog(text) {
  let content = scrub(text);
  const lines = content.split('\n');
  if (lines.length > 25000) content = lines.slice(-25000).join('\n');
  if (Buffer.byteLength(content) > 10 * 1024 * 1024) content = content.slice(-9 * 1024 * 1024);
  let res;
  try {
    res = await fetch('https://api.mclo.gs/1/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': '0Rzxn_ Launcher' },
      body: new URLSearchParams({ content }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new Error(`mclo.gs ne répond pas (${error.cause?.code ?? error.message}).`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(`mclo.gs a refusé le rapport${data?.error ? ` : ${data.error}` : ` (${res.status})`}.`);
  return { url: data.url, id: data.id };
}

module.exports = { listCrashes, crashFile, readCrashText, saveCrashLog, diagnose, shareLog, scrub, SOURCES };
