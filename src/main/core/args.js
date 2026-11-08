'use strict';

// Construction de la ligne de commande Java : formats moderne (arguments) et ancien (minecraftArguments).
const path = require('node:path');
const { jvmArguments } = require('./performance');
const { ruleAllows } = require('./rules');

function substitute(template, vars) {
  return template.replace(/\$\{([^}]+)\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole));
}

function collect(list, vars, features) {
  const out = [];
  for (const item of list ?? []) {
    if (typeof item === 'string') out.push(item);
    else if (ruleAllows(item.rules, features)) out.push(...[].concat(item.value));
  }
  return out.map((arg) => substitute(arg, vars));
}

function splitUserArgs(text) {
  return (text ?? '').match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, '')) ?? [];
}

/** La version gère-t-elle Quick Play (1.20 et plus) ? Lu dans les arguments du fichier de version. */
function supportsQuickPlay(version) {
  return (version.arguments?.game ?? []).some((item) => item?.rules?.some((rule) => rule.features?.is_quick_play_singleplayer));
}

/** Hôte et port d'une adresse de serveur (« play.exemple.fr », « 1.2.3.4:25570 », « [::1]:25565 »). */
function serverTarget(address) {
  const text = String(address).trim();
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(text) ?? /^([^:]+)(?::(\d+))?$/.exec(text);
  return m ? { host: m[1], port: Number(m[2] ?? 25565) } : { host: text, port: 25565 };
}

/**
 * `javaMajor` : version de Java qui lance le jeu (choix du ramasse-miettes, voir performance.js).
 * `quickPlay` : { type: 'singleplayer' | 'multiplayer', id } pour entrer directement dans un monde ou sur un serveur ;
 * `quickPlayPath` : fichier où le jeu note le monde ou le serveur rejoint (1.20 et plus).
 * Avant 1.20, seul un serveur peut être rejoint au démarrage (--server / --port).
 * @returns {{ jvm: string[], game: string[], librarySearchPath: string, gc: string, quickPlay: string | null }}
 */
function buildArguments({ version, vars, settings, loggingConfig, quickPlay = null, quickPlayPath = null, javaMajor = version.javaVersion?.majorVersion ?? 8 }) {
  const modern = supportsQuickPlay(version);
  const target = quickPlay?.type === 'singleplayer' || quickPlay?.type === 'multiplayer' ? quickPlay : null;
  const features = {
    is_demo_user: false,
    has_custom_resolution: !settings.fullscreen,
    has_quick_plays_support: modern && Boolean(quickPlayPath),
    is_quick_play_singleplayer: modern && target?.type === 'singleplayer',
    is_quick_play_multiplayer: modern && target?.type === 'multiplayer',
    is_quick_play_realms: false,
  };
  if (modern) {
    vars = {
      ...vars,
      quickPlayPath: quickPlayPath ?? '',
      quickPlaySingleplayer: target?.type === 'singleplayer' ? target.id : '',
      quickPlayMultiplayer: target?.type === 'multiplayer' ? target.id : '',
    };
  }
  const tuned = jvmArguments({ preset: settings.jvmPreset, javaMajor, ramGb: settings.ram, jvmArgs: settings.jvmArgs });
  const jvm = [...tuned.args, ...splitUserArgs(settings.jvmArgs)];

  let versionJvm;
  if (version.arguments?.jvm) {
    versionJvm = collect(version.arguments.jvm, vars, features);
  } else {
    versionJvm = [
      `-Djava.library.path=${vars.natives_directory}`,
      `-Dminecraft.launcher.brand=${vars.launcher_name}`,
      `-Dminecraft.launcher.version=${vars.launcher_version}`,
      '-cp',
      vars.classpath,
    ];
    if (process.platform === 'win32') {
      versionJvm.unshift('-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump');
    }
  }
  jvm.push(...versionJvm);

  if (loggingConfig && version.logging?.client?.argument) {
    jvm.push(substitute(version.logging.client.argument, { path: loggingConfig }));
  }
  jvm.push('-Dlog4j2.formatMsgNoLookups=true');

  let game;
  if (version.arguments?.game) {
    game = collect(version.arguments.game, vars, features);
  } else {
    game = (version.minecraftArguments ?? '').split(' ').filter(Boolean).map((arg) => substitute(arg, vars));
    if (!settings.fullscreen) game.push('--width', String(vars.resolution_width), '--height', String(vars.resolution_height));
  }
  if (settings.fullscreen) game.push('--fullscreen');
  let joined = modern && target ? target.type : null;
  if (!modern && target?.type === 'multiplayer') {
    const { host, port } = serverTarget(target.id);
    game.push('--server', host, '--port', String(port));
    joined = 'multiplayer';
  }

  const libraryArg = jvm.find((arg) => arg.startsWith('-Djava.library.path='));
  const librarySearchPath = libraryArg ? path.normalize(libraryArg.slice('-Djava.library.path='.length)) : vars.natives_directory;

  return { jvm, game, librarySearchPath, gc: tuned.gc, quickPlay: joined };
}

module.exports = { buildArguments, splitUserArgs, supportsQuickPlay, serverTarget };
