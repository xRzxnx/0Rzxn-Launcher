// @ts-check
'use strict';

// Pipeline de lancement : chaque étape est annoncée pour la barre de progression.
const { gb, num, t } = require('../i18n');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildArguments } = require('./args');
const { downloadAll } = require('./download');
const install = require('./install');
const { JAVA_32_MAX_GB, ensureRuntime, probeJavaCached } = require('./java');
const { GameLogParser, censor, clock } = require('./logs');
const { LOADER_NAMES, installLoader } = require('./loaders');
const titleMenu = require('./title-menu');
const { getVersionJson } = require('./versions');

const STEPS = ['account', 'components', 'files', 'java', 'loader', 'javaCheck', 'memory', 'natives', 'launch'];
const LAUNCHER_NAME = '0Rzxn_Launcher';
const GC_NAMES = { get g1() { return t('launch.g1_regle'); }, get zgc() { return t('launch.zgc_generationnel'); }, get none() { return t('launch.celui_de_java_par_defaut'); } };

/**
 * Événements :
 *  - 'progress' { step, done, total }       étape en cours (index dans STEPS)
 *  - 'log'      { time, tag, msg }          ligne de log (secrets masqués)
 *  - 'loaderInstalled' { versionId }        le loader de mods est installé
 *  - 'prepared'                            tout est prêt (mode prepareOnly, sans lancer le jeu)
 *  - 'running'  { pid }                     le jeu est démarré
 *  - 'failed'   { message, cancelled, code } échec avant le démarrage du jeu (code : JAVA_32_BIT…)
 *  - 'exit'     { code, crashed, minutes }  le jeu s'est fermé
 */
class LaunchSession extends EventEmitter {
  /**
   * `account` : compte prêt à l'emploi, ou `getAccount(log)` : fonction asynchrone appelée à l'étape
   * « Compte » (renouvellement de la session Microsoft).
   */
  constructor({ dirs, instance, instanceDir, account, getAccount, launcherVersion = '0.1.0', verify = false, prepareOnly = false, prepareJava = null, quickPlay = null }) {
    super();
    this.quickPlay = quickPlay; // { type: 'singleplayer' | 'multiplayer', id, name } : entrer directement dans un monde ou sur un serveur
    this.prepareJava = prepareJava; // ex. préférence de carte graphique pour ce java.exe
    this.prepareOnly = prepareOnly;
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

  /**
   * `bytes` : progression d'un téléchargement (doneBytes, totalBytes, speed, eta), transmise telle quelle.
   * @param {number} step @param {number} [done] @param {number} [total] @param {Record<string, any> | null} [bytes]
   */
  progress(step, done = 0, total = 0, bytes = null) {
    this.step = step;
    const extra = {};
    for (const key of ['doneBytes', 'totalBytes', 'speed', 'eta']) if (bytes?.[key] != null) extra[key] = bytes[key];
    this.emit('progress', { step, done, total, ...extra });
  }

  async start() {
    try {
      await this.run();
    } catch (error) {
      const cancelled = this.controller.signal.aborted;
      if (!cancelled) this.log(t('launch.echec', { message: error.message }), 'LAUNCHER/ERROR');
      this.emit('failed', { message: cancelled ? t('launch.lancement_annule') : error.message, cancelled, code: cancelled ? null : (error.code ?? null) });
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
    this.log(t('launch.summary', { name: instance.name, version: instance.version, account: account.name, type: account.type === 'offline' ? t('launch.offline') : 'Microsoft' }));

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
    await downloadAll(tasks, { signal, verify: this.verify, onProgress: (p) => this.progress(2, p.done, p.total, p) });
    this.log(t('launch.files_ready', { count: tasks.length, seconds: num((Date.now() - started) / 1000, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) }));

    // 4. Java
    this.progress(3);
    const required = version.javaVersion?.majorVersion ?? 8;
    let javaExe;
    if (settings.java === 'custom' && settings.javaPath) {
      if (!fs.existsSync(settings.javaPath)) throw new Error(t('launch.java_personnalise_introuvable', { javaPath: settings.javaPath }));
      javaExe = settings.javaPath;
    } else {
      const component = version.javaVersion?.component ?? 'jre-legacy';
      javaExe = await ensureRuntime(dirs, component, { signal, onProgress: (p) => this.progress(3, p.done, p.total, p) });
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
        onProgress: (p) => this.progress(4, p.done, p.total, p),
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
      await downloadAll(loaderTasks, { signal, verify: this.verify, onProgress: (p) => this.progress(4, p.done, p.total, p) });
      this.log(t('launch.pret', { LOADER_NAMES: LOADER_NAMES[instance.loader], loaderVersion: instance.loaderVersion, id: game.id }));
    }
    signal.throwIfAborted();

    // 6. Vérification de Java
    this.progress(5);
    const java = await probeJavaCached(javaExe);
    this.log(t('launch.java', { major: java.major, description: java.description, javaExe }));
    // Java 32 bits : il ne peut pas réserver plus d'environ 1,5 Go ; mieux vaut le dire que laisser Java échouer.
    if (java.bits === 32 && settings.ram > JAVA_32_MAX_GB) {
      throw Object.assign(new Error(t('launch.java_32_bits', { ram: gb(settings.ram) })), { code: 'JAVA_32_BIT' });
    }
    if (java.major < required) throw new Error(t('launch.minecraft_demande_java_mais_ce', { version: instance.version, required, major: java.major }));
    if (java.major !== required) this.log(t('launch.attention_java_est_recommande_pour', { required, major: java.major }), 'LAUNCHER/WARN');
    this.javaMajor = java.major;
    if (this.prepareJava) await this.prepareJava(javaExe, (msg) => this.log(msg)).catch((error) => this.log(t('launch.carte_graphique', { message: error.message }), 'LAUNCHER/WARN'));

    // 7. Mémoire disponible (l'avertissement est affiché par l'interface avant le lancement)
    this.progress(6);
    const freeGb = os.freemem() / 1024 ** 3;
    this.log(t('launch.memory', { ram: gb(settings.ram), free: gb(freeGb.toFixed(1)) }));

    // 8. Natives et assets anciens
    this.progress(7);
    fs.mkdirSync(this.gameDir, { recursive: true });
    if (instance.titleMenu) {
      // Un écran titre raté ne doit jamais empêcher de jouer.
      await titleMenu.refresh({ gameDir: this.gameDir, instance, player: account.name, keepEdits: true }).catch((error) => this.log(t('launch.menu_titre_erreur', { message: error.message }), 'LAUNCHER/WARN'));
    }
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
    // Le jeu note dans ce fichier le monde ou le serveur rejoint (1.20 et plus) : c'est la liste « Reprendre ».
    const quickPlayPath = quickPlayFile(this.instanceDir);
    fs.rmSync(quickPlayPath, { force: true });
    const { jvm, game: gameArgs, librarySearchPath, gc, quickPlay: joined } = buildArguments({ version: game, vars, settings, loggingConfig, quickPlay: this.quickPlay, quickPlayPath, javaMajor: this.javaMajor });
    if (this.quickPlay) {
      const name = this.quickPlay.name || this.quickPlay.id;
      if (!joined) this.log(t('launch.quick_play_impossible', { name }));
      else {
        this.log(t(joined === 'singleplayer' ? 'launch.quick_play_monde' : 'launch.quick_play_serveur', { name }));
        // Premier lancement : l'écran d'accessibilité du jeu bloquerait l'entrée directe.
        if (skipOnboarding(this.gameDir)) this.log(t('launch.ecran_accessibilite_passe'));
      }
    }
    this.log(t(settings.jvmPreset === 'auto' ? 'launch.gc_auto' : 'launch.gc', { gc: GC_NAMES[gc] }));
    const extracted = await install.extractNatives(gameLibraries.natives, librarySearchPath);
    this.log(t('launch.natives_extraites', { extracted }));
    signal.throwIfAborted();

    if (this.prepareOnly) {
      this.log(t('launch.fichiers_verifies_java_et_natives'));
      this.emit('prepared');
      return;
    }

    // 9. Lancement
    this.progress(8);
    const args = [...jvm, game.mainClass, ...gameArgs];
    this.log(t('launch.arguments_du_jeu', { gameArgs: gameArgs.join(' ') }));
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
      this.log(t('launch.minecraft_demarre_processus', { pid: child.pid }));
      if (priority === 'above') {
        try {
          os.setPriority(/** @type {number} */ (child.pid), os.constants.priority.PRIORITY_ABOVE_NORMAL);
          this.log(t('launch.priorite_du_jeu_au_dessus'));
        } catch (error) {
          this.log(t('launch.priorite_du_jeu_inchangee', { code: error.code ?? error.message }), 'LAUNCHER/WARN');
        }
      }
      this.emit('running', { pid: child.pid });
    });
    child.once('error', (/** @type {NodeJS.ErrnoException} */ error) => {
      if (reported) return;
      reported = true;
      this.log(t('launch.impossible_de_demarrer_java', { message: error.message }), 'LAUNCHER/ERROR');
      this.emit('failed', { message: t('launch.impossible_de_demarrer_java_2', { code: error.code ?? error.message }), cancelled: false });
    });
    child.once('close', (code, signalName) => {
      if (reported) return;
      reported = true;
      stdout.flush();
      stderr.flush();
      const minutes = Math.max(0, Math.round((Date.now() - startedAt) / 60000));
      const crashed = !this.stopped && code !== 0;
      this.log(this.stopped ? t('launch.jeu_arrete_depuis_le_launcher') : t('launch.jeu_ferme_code_de_sortie', { code: code ?? signalName }), crashed ? 'LAUNCHER/ERROR' : 'LAUNCHER');
      this.emit('exit', { code, crashed, minutes });
    });
  }
}

/** Fichier où le jeu note le dernier monde ou serveur rejoint (dans le dossier de l'instance, pas celui du jeu). */
function quickPlayFile(instanceDir) {
  return path.join(instanceDir, 'quickplay.json');
}

/** Met « onboardAccessibility » à false dans options.txt de l'instance (créé si besoin). Renvoie true si quelque chose a changé. */
function skipOnboarding(gameDir) {
  const file = path.join(gameDir, 'options.txt');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (/^onboardAccessibility:false\s*$/m.test(text)) return false;
  const next = /^onboardAccessibility:/m.test(text)
    ? text.replace(/^onboardAccessibility:.*$/m, 'onboardAccessibility:false')
    : `${text}${text && !text.endsWith('\n') ? '\n' : ''}onboardAccessibility:false\n`;
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(file, next);
  return true;
}

module.exports = { LaunchSession, STEPS, quickPlayFile };
