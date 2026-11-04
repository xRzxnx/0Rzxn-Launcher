'use strict';

// Pipeline de lancement : chaque étape est annoncée pour la barre de progression.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildArguments } = require('./args');
const { downloadAll } = require('./download');
const install = require('./install');
const { ensureRuntime, probeJava } = require('./java');
const { GameLogParser, censor, clock } = require('./logs');
const { LOADER_NAMES, installLoader } = require('./loaders');
const { resolveTarget } = require('./servers');
const { getVersionJson } = require('./versions');

const STEPS = ['account', 'components', 'files', 'java', 'loader', 'javaCheck', 'memory', 'natives', 'launch'];
const LAUNCHER_NAME = '0Rzxn_Launcher';
const GC_NAMES = { g1: 'G1 réglé', zgc: 'ZGC générationnel', none: 'celui de Java par défaut' };

/**
 * Événements :
 *  - 'progress' { step, done, total }       étape en cours (index dans STEPS)
 *  - 'log'      { time, tag, msg }          ligne de log (secrets masqués)
 *  - 'loaderInstalled' { versionId }        le loader de mods est installé
 *  - 'prepared'                            tout est prêt (mode prepareOnly, sans lancer le jeu)
 *  - 'running'  { pid }                     le jeu est démarré
 *  - 'failed'   { message, cancelled }      échec avant le démarrage du jeu
 *  - 'exit'     { code, crashed, minutes }  le jeu s'est fermé
 */
class LaunchSession extends EventEmitter {
  /**
   * `account` : compte prêt à l'emploi, ou `getAccount(log)` : fonction asynchrone appelée à l'étape
   * « Compte » (renouvellement de la session Microsoft).
   */
  constructor({ dirs, instance, instanceDir, account, getAccount, launcherVersion = '0.1.0', verify = false, prepareOnly = false, server = null, prepareJava = null }) {
    super();
    this.prepareJava = prepareJava; // ex. préférence de carte graphique pour ce java.exe
    this.prepareOnly = prepareOnly;
    this.server = server; // adresse d'un serveur à rejoindre dès le démarrage
    this.getAccount = getAccount ?? (async () => account);
    this.dirs = dirs;
    this.instance = instance;
    this.instanceDir = instanceDir;
    this.gameDir = path.join(instanceDir, 'minecraft');
    this.account = null;
    this.launcherVersion = launcherVersion;
    this.verify = verify;
    this.controller = new AbortController();
    this.secrets = [];
    this.child = null;
    this.stopped = false;
    this.step = 0;
  }

  log(msg, tag = 'LAUNCHER') {
    this.emit('log', { time: clock(), tag, msg: censor(msg, this.secrets) });
  }

  progress(step, done = 0, total = 0) {
    this.step = step;
    this.emit('progress', { step, done, total });
  }

  async start() {
    try {
      await this.run();
    } catch (error) {
      const cancelled = this.controller.signal.aborted;
      if (!cancelled) this.log(`Échec : ${error.message}`, 'LAUNCHER/ERROR');
      this.emit('failed', { message: cancelled ? 'Lancement annulé.' : error.message, cancelled });
    }
  }

  stop() {
    this.stopped = true;
    if (this.child) this.child.kill();
    else this.controller.abort();
  }

  async run() {
    const { dirs, instance } = this;
    const signal = this.controller.signal;
    const settings = instance.settings;

    // 1. Compte
    this.progress(0);
    const account = await this.getAccount((msg) => this.log(msg));
    this.account = account;
    this.secrets = [account.accessToken];
    signal.throwIfAborted();
    this.log(`Instance ${instance.name} · Minecraft ${instance.version} · compte ${account.name} (${account.type === 'offline' ? 'hors-ligne' : 'Microsoft'})`);

    // 2. Composants
    this.progress(1);
    const version = await getVersionJson(dirs, instance.version);
    signal.throwIfAborted();

    // 3. Fichiers du jeu
    this.progress(2);
    const libraries = install.resolveLibraries(version, dirs);
    const assets = await install.prepareAssets(version, dirs, { signal, verify: this.verify });
    const tasks = [install.clientTask(version, dirs), install.loggingTask(version, dirs), ...libraries.tasks, ...assets.tasks].filter(Boolean);
    const started = Date.now();
    await downloadAll(tasks, { signal, verify: this.verify, onProgress: (p) => this.progress(2, p.done, p.total) });
    this.log(`${tasks.length.toLocaleString('fr-FR')} fichiers prêts (${((Date.now() - started) / 1000).toFixed(1)} s)`);

    // 4. Java
    this.progress(3);
    const required = version.javaVersion?.majorVersion ?? 8;
    let javaExe;
    if (settings.java === 'custom' && settings.javaPath) {
      if (!fs.existsSync(settings.javaPath)) throw new Error(`Java personnalisé introuvable : ${settings.javaPath}`);
      javaExe = settings.javaPath;
    } else {
      const component = version.javaVersion?.component ?? 'jre-legacy';
      javaExe = await ensureRuntime(dirs, component, { signal, onProgress: (p) => this.progress(3, p.done, p.total) });
    }

    // 5. Loader de mods (après Java : les processeurs de Forge et NeoForge sont des programmes Java)
    this.progress(4);
    let game = version;
    let gameLibraries = libraries;
    if (instance.loader && instance.loader !== 'vanilla') {
      const versionId = await installLoader({
        dirs,
        mc: instance.version,
        loader: instance.loader,
        loaderVersion: instance.loaderVersion,
        javaExe,
        signal,
        onProgress: (p) => this.progress(4, p.done, p.total),
        log: (msg, tag) => this.log(msg, tag),
      });
      this.emit('loaderInstalled', { versionId });
      game = await getVersionJson(dirs, versionId);

      // Forge / NeoForge : le jar du jeu doit porter le nom de la version du loader (comme le launcher officiel).
      // Fabric / Quilt : on garde le jar vanilla tel quel, sinon Fabric confond ce jar avec le sien.
      if (instance.loader === 'fabric' || instance.loader === 'quilt') game.jar = version.jar ?? version.id;
      const target = install.clientJar(game, dirs);
      const source = install.clientJar(version, dirs);
      if (target !== source && !fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
      }
      gameLibraries = install.resolveLibraries(game, dirs);
      const loaderTasks = [install.clientTask(game, dirs), ...gameLibraries.tasks].filter(Boolean);
      await downloadAll(loaderTasks, { signal, verify: this.verify, onProgress: (p) => this.progress(4, p.done, p.total) });
      this.log(`${LOADER_NAMES[instance.loader]} ${instance.loaderVersion} prêt (${game.id})`);
    }
    signal.throwIfAborted();

    // 6. Vérification de Java
    this.progress(5);
    const java = await probeJava(javaExe);
    this.log(`Java ${java.major} (${java.description}) · ${javaExe}`);
    if (java.major < required) throw new Error(`Minecraft ${instance.version} demande Java ${required}, mais ce Java est la version ${java.major}.`);
    if (java.major !== required) this.log(`Attention : Java ${required} est recommandé pour cette version (Java ${java.major} utilisé).`, 'LAUNCHER/WARN');
    this.javaMajor = java.major;
    if (this.prepareJava) await this.prepareJava(javaExe, (msg) => this.log(msg)).catch((error) => this.log(`Carte graphique : ${error.message}`, 'LAUNCHER/WARN'));

    // 7. Mémoire disponible (l'avertissement est affiché par l'interface avant le lancement)
    this.progress(6);
    const freeGb = os.freemem() / 1024 ** 3;
    this.log(`Mémoire : ${settings.ram} Go demandés, ${freeGb.toFixed(1)} Go libres`);

    // 8. Natives et assets anciens
    this.progress(7);
    fs.mkdirSync(this.gameDir, { recursive: true });
    const gameAssets = await install.reconstructAssets(assets.index, version.assetIndex.id, dirs, this.gameDir);
    const vars = {
      auth_player_name: account.name,
      version_name: game.id,
      game_directory: this.gameDir,
      assets_root: dirs.assets,
      game_assets: gameAssets ?? dirs.assets,
      assets_index_name: version.assetIndex?.id ?? version.assets,
      auth_uuid: account.uuid,
      auth_access_token: account.accessToken,
      auth_session: `token:${account.accessToken}:${account.uuid}`,
      auth_xuid: account.xuid,
      clientid: crypto.randomUUID(),
      user_type: account.userType,
      user_properties: '{}',
      version_type: game.type ?? version.type,
      natives_directory: path.join(this.instanceDir, 'natives'),
      launcher_name: LAUNCHER_NAME,
      launcher_version: this.launcherVersion,
      classpath: [...gameLibraries.classpath, install.clientJar(game, dirs)].join(path.delimiter),
      classpath_separator: path.delimiter,
      library_directory: dirs.libraries,
      resolution_width: settings.width,
      resolution_height: settings.height,
    };
    const loggingConfig = install.loggingTask(game, dirs)?.path;
    const server = this.server ? { address: this.server, ...(await resolveTarget(this.server)) } : null;
    if (server) {
      this.log(`Connexion directe à ${this.server} au démarrage`);
      // Premier lancement : l'écran d'accessibilité du jeu bloque Quick Play, on le passe.
      if (skipOnboarding(this.gameDir)) this.log("Écran d'accessibilité du premier lancement passé pour rejoindre le serveur.");
    }
    const { jvm, game: gameArgs, librarySearchPath, gc } = buildArguments({ version: game, vars, settings, loggingConfig, server, javaMajor: this.javaMajor });
    this.log(`Ramasse-miettes : ${GC_NAMES[gc]}${settings.jvmPreset === 'auto' ? ' (automatique)' : ''}`);
    const extracted = await install.extractNatives(gameLibraries.natives, librarySearchPath);
    this.log(`${extracted} natives extraites`);
    signal.throwIfAborted();

    if (this.prepareOnly) {
      this.log('Fichiers vérifiés, Java et natives prêts.');
      this.emit('prepared');
      return;
    }

    // 9. Lancement
    this.progress(8);
    const args = [...jvm, game.mainClass, ...gameArgs];
    this.log(`Arguments du jeu : ${gameArgs.join(' ')}`);
    this.spawnGame(javaExe, args, settings.priority);
  }

  spawnGame(javaExe, args, priority = 'normal') {
    const child = spawn(javaExe, args, { cwd: this.gameDir, windowsHide: true });
    this.child = child;
    const startedAt = Date.now();
    const emitLine = (line) => this.emit('log', { ...line, msg: censor(line.msg, this.secrets) });
    const stdout = new GameLogParser(emitLine, 'sortie/INFO');
    const stderr = new GameLogParser(emitLine, 'sortie/WARN');
    child.stdout.setEncoding('utf8').on('data', (chunk) => stdout.push(chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => stderr.push(chunk));

    let reported = false;
    child.once('spawn', () => {
      this.log(`Minecraft démarré (processus ${child.pid})`);
      if (priority === 'above') {
        try {
          os.setPriority(child.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
          this.log('Priorité du jeu : au-dessus de la normale');
        } catch (error) {
          this.log(`Priorité du jeu inchangée (${error.code ?? error.message})`, 'LAUNCHER/WARN');
        }
      }
      this.emit('running', { pid: child.pid });
    });
    child.once('error', (error) => {
      if (reported) return;
      reported = true;
      this.log(`Impossible de démarrer Java : ${error.message}`, 'LAUNCHER/ERROR');
      this.emit('failed', { message: `Impossible de démarrer Java (${error.code ?? error.message}).`, cancelled: false });
    });
    child.once('close', (code, signalName) => {
      if (reported) return;
      reported = true;
      stdout.flush();
      stderr.flush();
      const minutes = Math.max(0, Math.round((Date.now() - startedAt) / 60000));
      const crashed = !this.stopped && code !== 0;
      this.log(this.stopped ? 'Jeu arrêté depuis le launcher.' : `Jeu fermé (code de sortie ${code ?? signalName}).`, crashed ? 'LAUNCHER/ERROR' : 'LAUNCHER');
      this.emit('exit', { code, crashed, minutes });
    });
  }
}

/** Met « onboardAccessibility » à false dans options.txt (créé si besoin). Renvoie true si quelque chose a changé. */
function skipOnboarding(gameDir) {
  const file = path.join(gameDir, 'options.txt');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (/^onboardAccessibility:false\s*$/m.test(text)) return false;
  const next = /^onboardAccessibility:/m.test(text)
    ? text.replace(/^onboardAccessibility:.*$/m, 'onboardAccessibility:false')
    : `${text}${text && !text.endsWith('\n') ? '\n' : ''}onboardAccessibility:false\n`;
  fs.writeFileSync(file, next);
  return true;
}

module.exports = { LaunchSession, STEPS };
