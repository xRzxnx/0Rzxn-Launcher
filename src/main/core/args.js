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

/**
 * `javaMajor` : version de Java qui lance le jeu (choix du ramasse-miettes, voir performance.js).
 * @returns {{ jvm: string[], game: string[], librarySearchPath: string, gc: string }}
 */
function buildArguments({ version, vars, settings, loggingConfig, javaMajor = version.javaVersion?.majorVersion ?? 8 }) {
  const features = {
    is_demo_user: false,
    has_custom_resolution: !settings.fullscreen,
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false,
  };
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

  const libraryArg = jvm.find((arg) => arg.startsWith('-Djava.library.path='));
  const librarySearchPath = libraryArg ? path.normalize(libraryArg.slice('-Djava.library.path='.length)) : vars.natives_directory;

  return { jvm, game, librarySearchPath, gc: tuned.gc };
}

module.exports = { buildArguments, splitUserArgs };
