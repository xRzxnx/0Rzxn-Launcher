'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { scanFile, notesLine } = require('../scripts/virustotal');

/** Faux VirusTotal : adresse d'envoi, envoi multipart, analyse qui finit après `pending` lectures. */
async function fakeVirusTotal(t, { key = 'cle-test', pending = 1, stats = { malicious: 0, suspicious: 0, undetected: 60, harmless: 0, 'type-unsupported': 10 }, quota = 0 } = {}) {
  const seen = { uploaded: 0, polls: 0, quotaLeft: quota };
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['x-apikey'] !== key) return send(401, { error: { code: 'WrongCredentialsError' } });
    if (seen.quotaLeft > 0) {
      seen.quotaLeft -= 1;
      return send(429, { error: { code: 'QuotaExceededError' } });
    }
    if (req.method === 'GET' && req.url === '/api/v3/files/upload_url') return send(200, { data: `http://127.0.0.1:${server.address().port}/upload/abc` });
    if (req.method === 'POST' && req.url === '/upload/abc') {
      assert.match(req.headers['content-type'], /^multipart\/form-data/);
      req.on('data', (chunk) => { seen.uploaded += chunk.length; });
      req.on('end', () => send(200, { data: { type: 'analysis', id: 'an-1' } }));
      return undefined;
    }
    if (req.method === 'GET' && req.url === '/api/v3/analyses/an-1') {
      seen.polls += 1;
      const done = seen.polls > pending;
      return send(200, { data: { attributes: { status: done ? 'completed' : 'queued', stats: done ? stats : {} } } });
    }
    return send(404, { error: { code: 'NotFoundError' } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { api: `http://127.0.0.1:${server.address().port}/api/v3`, seen };
}

function bigFile(t, size) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Setup.exe');
  fs.writeFileSync(file, crypto.randomBytes(size));
  return file;
}

test('fichier de plus de 32 Mo : envoi par l adresse spéciale, attente, résumé', async (t) => {
  const { api, seen } = await fakeVirusTotal(t, { pending: 2 });
  const file = bigFile(t, 33 * 1024 * 1024);
  const result = await scanFile(file, { apiKey: 'cle-test', api, pollMs: 1 });
  assert.ok(seen.uploaded > 33 * 1024 * 1024);
  assert.equal(seen.polls, 3);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.deepEqual(result, { sha256: digest, url: `https://www.virustotal.com/gui/file/${digest}`, malicious: 0, suspicious: 0, engines: 60, blocked: false });
  assert.equal(notesLine(result), `**VirusTotal** : 0 / 60 · [rapport · report · informe](${result.url})`);
});

test('3 détections ou plus : bloquée', async (t) => {
  const { api } = await fakeVirusTotal(t, { stats: { malicious: 3, suspicious: 1, undetected: 66 } });
  const result = await scanFile(bigFile(t, 1000), { apiKey: 'cle-test', api, pollMs: 1 });
  assert.equal(result.blocked, true);
  assert.equal(result.engines, 70);
  assert.match(notesLine(result), /3 \/ 70 \(\+1 suspicious\)/);
});

test('2 détections : publiée, notées', async (t) => {
  const { api } = await fakeVirusTotal(t, { stats: { malicious: 2, undetected: 68 } });
  assert.equal((await scanFile(bigFile(t, 1000), { apiKey: 'cle-test', api, pollMs: 1 })).blocked, false);
});

test('clé refusée', async (t) => {
  const { api } = await fakeVirusTotal(t);
  await assert.rejects(scanFile(bigFile(t, 1000), { apiKey: 'mauvaise', api, pollMs: 1 }), { status: 401, code: 'WrongCredentialsError' });
});

test('quota de la minute dépassé : attente puis reprise', async (t) => {
  const { api } = await fakeVirusTotal(t, { quota: 2 });
  assert.equal((await scanFile(bigFile(t, 1000), { apiKey: 'cle-test', api, pollMs: 1 })).malicious, 0);
});

test('analyse trop longue', async (t) => {
  const { api } = await fakeVirusTotal(t, { pending: 1000 });
  await assert.rejects(scanFile(bigFile(t, 1000), { apiKey: 'cle-test', api, pollMs: 1, timeoutMs: 20 }), { code: 'TIMEOUT' });
});
