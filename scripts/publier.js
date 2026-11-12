'use strict';

// Publie une version : la release est construite par GitHub Actions (workflow « Release ») depuis main,
// puis le launcher des utilisateurs la trouve tout seul. Ce script vérifie, lance le workflow et suit son avancement.
// À lancer depuis un terminal où « gh auth status » est connecté :
//   npm run publier            publie la version de package.json (1.2.3 stable, 1.2.3-beta.4 pré-version)
//   npm run publier -- --essai construit seulement, sur la branche actuelle (rien n'est publié)
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const GH_DEFAULT = 'C:\\Program Files\\GitHub CLI\\gh.exe';
const gh = fs.existsSync(GH_DEFAULT) ? GH_DEFAULT : 'gh';
const POLL_MS = 20_000;

/** 1.2.3 → stable ; 1.2.3-beta.4 → bêta (pré-release GitHub) ; autre chose → null. */
function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(String(version));
  if (!match) return null;
  return { version, tag: `v${version}`, beta: match[4] !== undefined };
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

function stop(message) {
  console.error(`Publication arrêtée : ${message}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Le workflow vient d'être lancé : retrouve son exécution (créée après `since`). */
async function findRun(branch, since) {
  for (let i = 0; i < 12; i += 1) {
    await sleep(5000);
    const list = run(gh, ['run', 'list', '--workflow', 'release.yml', '--event', 'workflow_dispatch', '--branch', branch, '--limit', '5', '--json', 'databaseId,createdAt,url']);
    if (!list.ok) continue;
    const found = JSON.parse(list.out || '[]').find((r) => Date.parse(r.createdAt) >= since - 10_000);
    if (found) return found;
  }
  return null;
}

async function follow(id) {
  let last = '';
  for (;;) {
    const view = run(gh, ['run', 'view', String(id), '--json', 'status,conclusion,jobs']);
    if (view.ok) {
      const { status, conclusion, jobs = [] } = JSON.parse(view.out);
      const step = jobs[0]?.steps?.find((s) => s.status === 'in_progress')?.name;
      const line = status === 'completed' ? `terminé : ${conclusion}` : `${status}${step ? ` · ${step}` : ''}`;
      if (line !== last) console.log(`  ${new Date().toLocaleTimeString('fr-FR')}  ${line}`);
      last = line;
      if (status === 'completed') return conclusion;
    }
    await sleep(POLL_MS);
  }
}

async function main(argv) {
  const essai = argv.includes('--essai');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const parsed = parseVersion(version);
  if (!parsed) stop(`la version ${version} doit ressembler à 1.2.3 ou 1.2.3-beta.4.`);

  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  if (!essai && branch !== 'main') stop('il faut être sur la branche main.');
  if (run('git', ['status', '--porcelain']).out) stop('des changements ne sont pas commités.');
  run('git', ['fetch', 'origin', '--tags', '--quiet']);
  if (run('git', ['rev-parse', 'HEAD']).out !== run('git', ['rev-parse', `origin/${branch}`]).out) stop(`${branch} doit être poussée sur GitHub telle quelle.`);
  if (!essai && run('git', ['tag', '--list', parsed.tag]).out) stop(`le tag ${parsed.tag} existe déjà : change la version dans package.json.`);
  if (!run(gh, ['auth', 'status']).ok) stop('gh n’est pas connecté dans ce terminal.');
  if (!essai && !fs.existsSync(path.join(root, 'docs', `release-notes-${version}.md`))) console.log(`Pas de docs/release-notes-${version}.md : les notes seront les titres des commits.`);

  const since = Date.now();
  const args = ['workflow', 'run', 'release.yml', '--ref', branch];
  if (essai) args.push('-f', 'dry-run=true');
  const started = run(gh, args);
  if (!started.ok) stop(`GitHub n’a pas lancé le workflow (${started.err}).`);
  console.log(`${essai ? 'Essai de construction' : `Publication de ${parsed.tag}${parsed.beta ? ' (bêta)' : ''}`} lancé sur GitHub Actions…`);

  const found = await findRun(branch, since);
  if (!found) stop('exécution introuvable : regarde l’onglet Actions du dépôt.');
  console.log(`Suivi : ${found.url}`);
  const conclusion = await follow(found.databaseId);
  if (conclusion !== 'success') stop(`le workflow a échoué (${conclusion}). Détails : gh run view ${found.databaseId} --log-failed`);
  if (essai) console.log('Essai réussi : l’installateur est dans les artefacts de l’exécution (7 jours).');
  else console.log(`${parsed.tag} est publiée${parsed.beta ? ' en pré-version (seuls les launchers en canal bêta la verront)' : ''}. Les launchers installés la verront à leur prochaine recherche.`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { parseVersion };
