'use strict';

// Publie une version sur GitHub : le launcher des utilisateurs la trouve ensuite tout seul.
// À lancer depuis un terminal où « gh auth status » est connecté : npm run publier
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { version } = require('../package.json');
const tag = `v${version}`;

function run(command, args, { quiet = true } = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit', shell: command === 'npm' });
  if (result.error) throw result.error;
  return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

function stop(message) {
  console.error(`Publication arrêtée : ${message}`);
  process.exit(1);
}

const GH_DEFAULT = 'C:\\Program Files\\GitHub CLI\\gh.exe';
const gh = fs.existsSync(GH_DEFAULT) ? GH_DEFAULT : 'gh';

if (!/^\d+\.\d+\.\d+$/.test(version)) stop(`la version ${version} doit ressembler à 1.2.3.`);
if (run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out !== 'main') stop('il faut être sur la branche main.');
if (run('git', ['status', '--porcelain']).out) stop('des changements ne sont pas commités.');

run('git', ['fetch', 'origin', '--tags', '--quiet']);
if (run('git', ['rev-parse', 'HEAD']).out !== run('git', ['rev-parse', 'origin/main']).out) stop('main doit être poussée sur GitHub telle quelle.');
if (run('git', ['tag', '--list', tag]).out) stop(`le tag ${tag} existe déjà : change la version dans package.json.`);
if (!run(gh, ['auth', 'status']).ok) stop('gh n’est pas connecté dans ce terminal.');

// Les nouveautés : docs/release-notes-<version>.md si le fichier existe, sinon les titres des commits.
const previous = run('git', ['describe', '--tags', '--abbrev=0']);
const range = previous.ok ? `${previous.out}..HEAD` : 'HEAD';
const written = path.join(root, 'docs', `release-notes-${version}.md`);
const notes = fs.existsSync(written) ? fs.readFileSync(written, 'utf8') : run('git', ['log', range, '--no-merges', '--format=- %s']).out;

console.log(`Construction de ${tag}…`);
if (!run('npm', ['run', 'dist'], { quiet: false }).ok) stop('la construction a échoué.');

const dist = path.join(root, 'dist');
const installer = `0Rzxn_-Launcher-Setup-${version}.exe`;
const files = [installer, `${installer}.blockmap`, 'latest.yml'].map((name) => path.join(dist, name));
for (const file of files) if (!fs.existsSync(file)) stop(`${path.basename(file)} est introuvable dans dist.`);
if (!fs.readFileSync(files[2], 'utf8').includes(`version: ${version}`)) stop('latest.yml ne correspond pas à cette version.');

const created = run(gh, ['release', 'create', tag, ...files, '--title', tag, '--notes', notes || 'Corrections et améliorations.', '--target', 'main', '--latest'], { quiet: false });
if (!created.ok) stop('GitHub a refusé la publication.');
console.log(`${tag} est publiée. Les launchers installés la verront à leur prochaine recherche.`);
