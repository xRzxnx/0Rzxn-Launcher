'use strict';

// Analyse un installateur sur VirusTotal (API publique v3, clé gratuite) avant la publication d'une release.
// Usage : VIRUSTOTAL_API_KEY=... node scripts/virustotal.js <fichier> [--json resultat.json]
// Code de sortie : 0 analyse finie sous le seuil, 2 trop de détections, 1 erreur.
// Sans clé, rien n'est envoyé : le script affiche seulement le lien de recherche par empreinte.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const API = process.env.VIRUSTOTAL_API || 'https://www.virustotal.com/api/v3';
const GUI = 'https://www.virustotal.com/gui/file';
/** Moteurs qui doivent déclarer le fichier malveillant pour que la release reste en brouillon. */
const BLOCK_AT = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

/**
 * @param {string} file
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} [options.api] adresse de l'API (faux serveur dans les tests)
 * @param {number} [options.pollMs] attente entre deux lectures de l'analyse (30 s : la clé gratuite permet 4 requêtes/min)
 * @param {number} [options.timeoutMs] durée maximale de l'analyse
 * @param {(line: string) => void} [options.log]
 */
async function scanFile(file, { apiKey, api = API, pollMs = 30_000, timeoutMs = 20 * 60_000, log = () => {} }) {
  const headers = { 'x-apikey': apiKey, accept: 'application/json' };

  // 429 = quota de la minute dépassé : on attend et on réessaie quelques fois.
  async function call(url, init = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
      if (response.status === 429 && attempt < 3) {
        log('VirusTotal quota reached, waiting 60 s.');
        await sleep(Math.min(60_000, pollMs * 2));
        continue;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const reason = body?.error?.code ?? `HTTP ${response.status}`;
        throw Object.assign(new Error(`VirusTotal refused the request (${reason}).`), { status: response.status, code: body?.error?.code });
      }
      return body;
    }
  }

  const digest = await sha256(file);
  // L'envoi direct est limité à 32 Mo : l'adresse spéciale accepte jusqu'à 650 Mo.
  const { data: uploadUrl } = await call(`${api}/files/upload_url`);
  const form = new FormData();
  form.append('file', await fs.openAsBlob(file), path.basename(file));
  log(`Uploading ${path.basename(file)} (${fs.statSync(file).size} bytes).`);
  const { data: analysis } = await call(uploadUrl, { method: 'POST', body: form });

  const started = Date.now();
  for (;;) {
    await sleep(pollMs);
    const { data } = await call(`${api}/analyses/${analysis.id}`);
    const { status, stats = {} } = data.attributes ?? {};
    if (status === 'completed') {
      const engines = Object.values(stats).reduce((sum, n) => sum + (Number(n) || 0), 0) - (stats['type-unsupported'] ?? 0);
      const malicious = stats.malicious ?? 0;
      const suspicious = stats.suspicious ?? 0;
      return { sha256: digest, url: `${GUI}/${digest}`, malicious, suspicious, engines, blocked: malicious >= BLOCK_AT };
    }
    if (Date.now() - started > timeoutMs) throw Object.assign(new Error('VirusTotal analysis took too long.'), { code: 'TIMEOUT', sha256: digest });
    log(`Analysis ${status ?? 'pending'}…`);
  }
}

/** Ligne ajoutée aux notes de la release (lisible dans les trois langues). */
function notesLine(result) {
  const extra = result.suspicious ? ` (+${result.suspicious} suspicious)` : '';
  return `**VirusTotal** : ${result.malicious} / ${result.engines}${extra} · [rapport · report · informe](${result.url})`;
}

async function main(argv) {
  const file = argv[0];
  const jsonIndex = argv.indexOf('--json');
  const jsonFile = jsonIndex > -1 ? argv[jsonIndex + 1] : null;
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: node scripts/virustotal.js <file> [--json result.json]');
    return 1;
  }
  const apiKey = process.env.VIRUSTOTAL_API_KEY;
  if (!apiKey) {
    const digest = await sha256(file);
    console.log(`No VIRUSTOTAL_API_KEY: nothing uploaded. Search by hash: ${GUI}/${digest}`);
    if (jsonFile) fs.writeFileSync(jsonFile, JSON.stringify({ skipped: true, sha256: digest, url: `${GUI}/${digest}` }));
    return 0;
  }
  const pollMs = Number(process.env.VIRUSTOTAL_POLL_MS) || undefined;
  const result = await scanFile(file, { apiKey, pollMs, log: (line) => console.log(line) });
  console.log(`${result.malicious} / ${result.engines} engines flagged the file, ${result.suspicious} suspicious: ${result.url}`);
  if (jsonFile) fs.writeFileSync(jsonFile, JSON.stringify({ ...result, notes: notesLine(result) }));
  if (result.blocked) {
    console.error(`${result.malicious} engines or more flag the installer (limit ${BLOCK_AT}): the release stays a draft.`);
    return 2;
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}

module.exports = { scanFile, notesLine, main, BLOCK_AT };
