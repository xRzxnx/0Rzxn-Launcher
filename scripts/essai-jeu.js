'use strict';

// Essai réel sur la CI (Linux et macOS) : ouvre le launcher construit, crée des instances par son API,
// lance chaque partie jusqu'au menu, prend une capture d'écran puis arrête le jeu.
// Usage : node scripts/essai-jeu.js <exécutable du launcher> <dossier des captures> [arguments du launcher…]
// Ne pas lancer sur un vrai PC : il écrit un compte hors-ligne dans les réglages du launcher.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [exe, shots, ...extraArgs] = process.argv.slice(2);
const PORT = 9333;
const CASES = [
  { name: 'Vanilla', version: '1.21.11', loader: 'vanilla' },
  { name: 'Fabric', version: '1.21.11', loader: 'fabric' },
  { name: 'Ancienne', version: '1.12.2', loader: 'vanilla' }, // Mac : -XstartOnFirstThread, et Rosetta sur Apple Silicon
];
// Le jeu a chargé ses textures : le menu titre s'affiche juste après.
const MENU = /Created: \d+x\d+(x\d+)? .*atlas/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function userData() {
  const product = '0Rzxn_ Launcher';
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', product);
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), product);
}

function seedAccount() {
  const dir = userData();
  fs.mkdirSync(dir, { recursive: true });
  const id = 'offline-essai';
  const account = { id, type: 'offline', name: 'Essai', uuid: '00000000000030008000000000000001' };
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ activeId: id, accounts: [account] }));
}

function screenshot(file) {
  try {
    if (process.platform === 'darwin') execFileSync('screencapture', ['-x', file]);
    else execFileSync('import', ['-window', 'root', file]);
  } catch (error) {
    console.log(`capture impossible : ${error.message}`);
  }
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = pages.find((p) => p.type === 'page' && p.url.endsWith('index.html'));
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // pas encore prêt
    }
    await sleep(1000);
  }
  throw new Error("la fenêtre du launcher n'est pas apparue en 60 s");
}

/** Évalue une expression dans la page et renvoie sa valeur (promesse attendue). */
function evaluator(url) {
  const ws = new WebSocket(url);
  let next = 1;
  const waiting = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const done = waiting.get(msg.id);
    if (!done) return;
    waiting.delete(msg.id);
    const failure = msg.error?.message ?? msg.result?.exceptionDetails?.exception?.description;
    if (failure) done.reject(new Error(failure));
    else done.resolve(msg.result.result.value);
  };
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('connexion CDP impossible'));
  });
  const run = async (expression) => {
    await ready;
    const id = next++;
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
  };
  run.close = () => ws.close();
  return run;
}

async function play(run, test) {
  let loaderVersion = null;
  if (test.loader !== 'vanilla') {
    const loaders = await run(`window.launcher.versions.loaders(${JSON.stringify(test.version)})`);
    loaderVersion = loaders[test.loader].recommended;
  }
  const data = { name: test.name, version: test.version, loader: test.loader, loaderVersion };
  const instance = await run(`window.launcher.instances.create(${JSON.stringify(data)})`);
  console.log(`\n== ${test.name} (${test.version} ${test.loader}${loaderVersion ? ` ${loaderVersion}` : ''}) : ${instance.id}`);
  await run(`window.launcher.launch.start(${JSON.stringify(instance.id)}, { skipBackup: true })`);

  const start = Date.now();
  const lines = [];
  let ran = false;
  let menu = false;
  while (Date.now() - start < 10 * 60_000) {
    await sleep(2000);
    const state = await run('window.launcher.launch.state()');
    for (const line of state.logs ?? []) {
      const text = typeof line === 'string' ? line : JSON.stringify(line);
      if (!lines.includes(text)) lines.push(text);
    }
    if (state.run?.phase === 'running') ran = true;
    if (lines.some((l) => MENU.test(l))) {
      menu = true;
      break;
    }
    if (!state.run && (ran || state.ended || Date.now() - start > 30_000)) break; // partie terminée ou échec de préparation
  }
  await sleep(menu ? 8000 : 0); // laisse le menu se dessiner
  screenshot(path.join(shots, `${process.platform}-${test.name}.png`));
  await run('window.launcher.launch.stop()').catch(() => {});
  console.log(lines.slice(-40).join('\n'));
  console.log(`== ${test.name} : ${menu ? 'MENU ATTEINT' : ran ? 'jeu lancé, menu non détecté' : 'ÉCHEC avant le jeu'} en ${Math.round((Date.now() - start) / 1000)} s`);
  for (let i = 0; i < 30 && (await run('window.launcher.launch.state()')).run; i++) await sleep(1000);
  return menu;
}

async function main() {
  fs.mkdirSync(shots, { recursive: true });
  seedAccount();
  const app = spawn(exe, [`--remote-debugging-port=${PORT}`, ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
  const appLog = fs.createWriteStream(path.join(shots, `${process.platform}-launcher.log`));
  app.stdout.pipe(appLog);
  app.stderr.pipe(appLog);
  let exited = null;
  app.on('exit', (code, signal) => (exited = `${code ?? signal}`));

  const run = evaluator(await connect().catch((error) => {
    throw new Error(`${error.message}${exited ? ` (launcher fermé : ${exited})` : ''}`);
  }));
  await sleep(3000);
  console.log('info :', JSON.stringify(await run('window.launcher.info()')));
  screenshot(path.join(shots, `${process.platform}-accueil.png`));

  const results = [];
  for (const test of CASES) {
    try {
      results.push([test.name, await play(run, test)]);
    } catch (error) {
      console.log(`== ${test.name} : ERREUR ${error.message}`);
      results.push([test.name, false]);
    }
  }
  run.close();
  app.kill();
  console.log('\nRésultat :', results.map(([name, ok]) => `${name} ${ok ? 'ok' : 'non'}`).join(', '));
  process.exitCode = results.every(([, ok]) => ok) ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
