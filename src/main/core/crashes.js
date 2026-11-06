'use strict';

// Rapports de crash : rapports du jeu (crash-reports), plantages de Java (hs_err_pid*.log) et logs
// gardés par le launcher quand le jeu s'arrête sur une erreur. Chaque rapport est expliqué en français
// quand l'erreur est connue, et peut être partagé sur mclo.gs.
const { gb, t } = require('../i18n');
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
  report: { dir: ({ gameDir }) => path.join(gameDir, 'crash-reports'), name: /^crash-.+\.txt$/i, get kind() { return t('crashes.kind_report'); } },
  jvm: { dir: ({ gameDir }) => gameDir, name: /^hs_err_pid\d+\.log$/i, get kind() { return t('crashes.kind_jvm'); } },
  log: { dir: ({ instanceDir }) => path.join(instanceDir, LOG_DIR), name: /^launcher-[\d_-]+\.log$/i, get kind() { return t('crashes.kind_log'); } },
};

function crashFile(dirs, source, file) {
  const def = SOURCES[source];
  if (!def || typeof file !== 'string' || file !== path.basename(file) || !def.name.test(file)) throw new Error(t('crashes.rapport_invalide'));
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
  await fsp.writeFile(path.join(dir, file), t('crashes.0rzxn_launcher_jeu_ferme_avec', { body, code }));
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
      label: t('crashes.java_incompatible'),
      title: need ? t(have ? 'crashes.need_java_not' : 'crashes.need_java', { need, have }) : t('crashes.cette_version_de_java_ne'),
      text: t(need ? (have ? 'crashes.compiled_for_need_have' : 'crashes.compiled_for_need') : have ? 'crashes.compiled_for_have' : 'crashes.compiled_for', { need, have }),
      advice: usingCustom
        ? t('crashes.ton_instance_utilise_un_java')
        : t('crashes.si_un_seul_mod_demande'),
      actions: usingCustom ? [{ type: 'settings', label: t('crashes.ouvrir_les_reglages_java') }] : [{ type: 'mods', label: t('crashes.ouvrir_onglet_mods') }],
    }, line);
  };
  const missing = (requester, depId, rawName, range, line) => {
    if (depId === 'java') return javaProblem(String(range).match(/\d+/)?.[0], context.java, line);
    if (BUILTIN.has(depId)) return;
    const depName = rawName ?? KNOWN_NAMES[depId] ?? null;
    add(`missing:${depId}`, {
      id: 'missing',
      label: t('crashes.mod_manquant'),
      title: t('crashes.besoin_de_qui_est_pas', { name: requester.name, depName: depName ?? depId }),
      text: t('crashes.missing_dep_text', { mod: [requester.name, requester.version].filter(Boolean).join(' '), dep: `${depName ?? depId}${range && range !== 'any version' ? ` (${range})` : ''}` }),
      advice: t('crashes.installe_pour_cette_version_de', { depName: depName ?? depId, name: requester.name }),
      actions: [
        { type: 'install', slug: slugOf(depId), label: t('crashes.installer', { depName: depName ?? depId }) },
        requester.id && { type: 'disable', modId: requester.id, label: t('crashes.desactiver', { name: requester.name }) },
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
      label: isGame ? t('crashes.mod_pour_une_autre_version') : t('crashes.mauvaise_version_de_dependance'),
      title: isGame ? t('crashes.est_fait_pour_minecraft', { name: requester.name, range }) : t('crashes.demande_une_autre_version_de', { name: requester.name, depName: depName ?? depId }),
      text: t('crashes.wrong_dep_text', { mod: [requester.name, requester.version].filter(Boolean).join(' '), dep: depName ?? depId, range, present }),
      advice: isGame
        ? t('crashes.remplace_par_sa_version_pour', { name: requester.name, present })
        : t('crashes.mets_jour_ou_depuis_onglet', { depName: depName ?? depId, name: requester.name }),
      actions: [{ type: 'disable', modId: requester.id, label: t('crashes.desactiver', { name: requester.name }) }, { type: 'mods', label: t('crashes.ouvrir_onglet_mods') }],
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
        label: t('common.mods_incompatibles'),
        title: t('crashes.ne_fonctionne_pas_avec', { m: m[1], other }),
        text: t('crashes.declare_etre_incompatible_avec_les', { m: m[1], other }),
        advice: t('crashes.desactive_un_des_deux'),
        actions: [{ type: 'disable', modId: m[2], label: t('crashes.desactiver_2', { m: m[1] }) }],
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
      missing({ name: t('crashes.un_mod') }, 'fabric-api', 'Fabric API', null, i);
    } else if ((m = /java\.lang\.OutOfMemoryError(?:: (.+))?/.exec(line))) {
      add('memory', {
        id: 'memory',
        label: t('crashes.memoire_insuffisante'),
        title: t('crashes.le_jeu_manque_de_memoire'),
        text: t('crashes.oom_heap_text', { detail: `${context.ram ? ` (${gb(context.ram)})` : ''}${m[1] ? t('crashes.oom_detail', { message: m[1].trim() }) : ''}` }),
        advice: t('crashes.donne_plus_de_memoire_instance'),
        actions: [{ type: 'settings', label: t('crashes.changer_la_memoire') }],
      }, i);
    } else if (/Could not reserve enough space for .*object heap|Invalid maximum heap size/.test(line)) {
      add('reserve', {
        id: 'memory',
        label: t('crashes.memoire_insuffisante'),
        title: t('crashes.java_pas_pu_reserver_la'),
        text: t('crashes.oom_reserve_text', { detail: context.ram ? ` (${gb(context.ram)})` : '' }),
        advice: t('crashes.baisse_la_memoire_de_instance'),
        actions: [{ type: 'settings', label: t('crashes.changer_la_memoire') }],
      }, i);
    } else if (/There is insufficient memory for the Java Runtime Environment/.test(line)) {
      add('native-memory', {
        id: 'memory',
        label: t('crashes.memoire_insuffisante'),
        title: t('crashes.ton_pc_avait_plus_assez'),
        text: t('crashes.java_demande_de_la_memoire'),
        advice: t('crashes.ferme_des_programmes_navigateur_autres'),
        actions: [{ type: 'settings', label: t('crashes.changer_la_memoire') }],
      }, i);
    } else if (/Pixel format not accelerated|GLFW error 65542|WGL: The driver does not appear to support OpenGL|No OpenGL context found/i.test(line)) {
      add('gpu', gpuProblem(null), i);
    } else if ((m = /Mixin apply(?: for mod ([\w.-]+))? failed:? ?([\w.-]+\.json)?/.exec(line)) || (m = /(?:MixinApplyError|InvalidInjectionException|InvalidMixinException|MixinTransformerError).*?([\w-]+)\.mixins?\.json/.exec(line))) {
      const mod = m[1] && !m[1].endsWith('.json') ? m[1] : (m[2] ?? m[1] ?? '').replace(/(\.client|\.common)?\.mixins?\.json$/, '') || null;
      add(`mixin:${mod}`, {
        id: 'mixin',
        label: t('crashes.mod_incompatible'),
        title: mod ? t('crashes.pas_pu_modifier_le_jeu', { mod }) : t('crashes.un_mod_pas_pu_modifier'),
        text: t(mod ? 'crashes.mixin_text_mod' : 'crashes.mixin_text', { mod }),
        advice: mod ? t('crashes.mets_jour_ou_desactive_le', { mod }) : t('crashes.mets_tes_mods_jour_depuis'),
        actions: [mod && { type: 'disable', modId: mod, label: t('crashes.desactiver_3', { mod }) }, { type: 'mods', label: t('crashes.ouvrir_onglet_mods') }].filter(Boolean),
      }, i);
    } else if (/java\.util\.zip\.ZipException|zip END header not found|invalid LOC header|error in opening zip file|ZipError/.test(line)) {
      const jar = /([\w.+-]+\.jar)/.exec(line)?.[1] ?? /([\w.+-]+\.jar)/.exec(lines[i + 1] ?? '')?.[1] ?? null;
      add('corrupt', {
        id: 'corrupt',
        label: t('crashes.fichier_abime'),
        title: jar ? t('crashes.le_fichier_est_abime', { jar }) : t('crashes.un_fichier_jar_est_abime'),
        text: t('crashes.java_arrive_pas_ouvrir_une'),
        advice: jar ? t('crashes.supprime_et_reinstalle_le_puis', { jar }) : t('crashes.lance_verifier_nouveau_sur_accueil'),
        actions: [{ type: 'verify', label: t('crashes.verifier_les_fichiers') }],
      }, i);
    } else if (/Java HotSpot\(TM\) Client VM|JVM is 32-bit|32-bit Java/i.test(line)) {
      add('java32', {
        id: 'java32',
        label: t('crashes.java_32_bits'),
        title: t('crashes.le_jeu_tourne_avec_un'),
        text: t('crashes.un_java_32_bits_ne'),
        advice: t('crashes.repasse_en_java_automatique_le'),
        actions: [{ type: 'settings', label: t('crashes.ouvrir_les_reglages_java') }],
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
    label: t('crashes.pilote_graphique'),
    title: vendor ? t('crashes.le_pilote_graphique_plante', { vendor }) : t('crashes.le_pilote_graphique_ne_convient'),
    text: dll
      ? t('crashes.java_est_arrete_dans_un', { dll })
      : t('crashes.le_jeu_pas_pu_ouvrir'),
    advice: t(vendor ? 'crashes.driver_advice_vendor' : 'crashes.driver_advice', { vendor, site: { NVIDIA: ' (GeForce Experience, nvidia.com)', AMD: ' (AMD Software, amd.com)', Intel: ' (intel.com)' }[vendor] ?? '' }),
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
      label: t('crashes.mod_en_cause'),
      title: t('crashes.le_plantage_vient_sans_doute', { names }),
      text: t(error ? 'crashes.suspect_error' : 'crashes.suspect', { count: suspects.length, error }),
      advice: t('crashes.suspect_advice', { count: suspects.length }),
      actions: suspects.slice(0, 2).map((s) => ({ type: 'disable', modId: s.modId, label: t('crashes.desactiver', { name: s.name }) })),
      lines: [errorAt, descriptionAt].filter((n) => n >= 0),
    };
  }
  return {
    id: 'unknown',
    label: t('crashes.erreur_inconnue'),
    title: t('crashes.le_launcher_ne_reconnait_pas'),
    text: error ? t('crashes.le_jeu_est_arrete_sur', { error }) : t('crashes.le_jeu_est_arrete_sans'),
    advice: t('crashes.partage_le_rapport_sur_mclo'),
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
    throw new Error(t('crashes.mclo_gs_ne_repond_pas', { code: error.cause?.code ?? error.message }));
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.error ? t('crashes.mclogs_refused_error', { error: data.error }) : t('crashes.mclogs_refused', { status: res.status }));
  return { url: data.url, id: data.id };
}

module.exports = { listCrashes, crashFile, readCrashText, saveCrashLog, diagnose, shareLog, scrub, SOURCES };
