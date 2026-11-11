'use strict';

// Connexion Microsoft dans le navigateur (phase 7) : adresse de retour locale, page de fin, adresse d'autorisation,
// renouvellement avec la même sorte d'adresse de retour.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { openLoopback } = require('../src/main/core/loopback');
const { loginPage } = require('../src/main/core/login-page');
const microsoft = require('../src/main/core/microsoft');
const { AccountStore } = require('../src/main/core/accounts');

/** Requête GET locale ; `host` remplace l'en-tête Host. */
function get(port, pathname, { host = `localhost:${port}`, method = 'GET', address = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: address, port, path: pathname, method, headers: { Host: host }, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function open(t, options = {}) {
  const loopback = await openLoopback({ state: 'bon-etat', ...options });
  t.after(() => loopback.close());
  return loopback;
}

test('loopback : adresse http://localhost:<port>, le code revient, la page attend le vrai résultat', async (t) => {
  const loopback = await open(t);
  assert.equal(loopback.redirectUri, `http://localhost:${loopback.port}`);
  const page = get(loopback.port, '/?code=abc&state=bon-etat');
  assert.deepEqual(await loopback.wait, { code: 'abc' });
  // Rien n'est encore répondu : le launcher vérifie le compte.
  let answered = false;
  page.then(() => { answered = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(answered, false);
  loopback.respond({ kind: 'ok', name: 'Steve_42' });
  const res = await page;
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/html; charset=utf-8/);
  assert.match(res.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.match(res.body, /<b>Steve_42<\/b>/);
  assert.doesNotMatch(res.body, /<script|https?:\/\//);
  // Le serveur est fermé ensuite.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(get(loopback.port, '/?code=abc&state=bon-etat'), { code: 'ECONNREFUSED' });
});

test('loopback : écoute aussi sur ::1 quand IPv6 existe', async (t) => {
  const loopback = await open(t);
  const page = get(loopback.port, '/?code=v6&state=bon-etat', { address: '::1', host: `[::1]:${loopback.port}` });
  const first = await Promise.race([loopback.wait, page.then(() => 'page', (error) => error)]);
  if (first instanceof Error) {
    if (['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ECONNREFUSED'].includes(first.code)) return t.skip('pas d’IPv6 ici');
    throw first;
  }
  assert.deepEqual(first, { code: 'v6' });
  loopback.respond({ kind: 'ok', name: 'A' });
  assert.equal((await page).status, 200);
});

test('loopback : requêtes refusées (chemin, méthode, Host, sans code)', async (t) => {
  const loopback = await open(t);
  const { port } = loopback;
  assert.equal((await get(port, '/favicon.ico')).status, 404);
  assert.equal((await get(port, '/autre?code=abc&state=bon-etat')).status, 404);
  assert.equal((await get(port, '/?code=abc&state=bon-etat', { method: 'POST' })).status, 404);
  assert.equal((await get(port, '/?code=abc&state=bon-etat', { host: `evil.example:${port}` })).status, 404);
  assert.equal((await get(port, '/?code=abc&state=bon-etat', { host: 'localhost:1' })).status, 404);
  assert.equal((await get(port, '/')).status, 404);
  // Aucune de ces requêtes n'a terminé l'attente.
  const page = get(port, '/?code=ok&state=bon-etat', { host: `127.0.0.1:${port}` });
  assert.deepEqual(await loopback.wait, { code: 'ok' });
  loopback.respond({ kind: 'ok', name: 'A' });
  assert.equal((await page).status, 200);
});

test('loopback : mauvais state refusé (page « réponse inattendue »), la bonne réponse reste attendue', async (t) => {
  const loopback = await open(t);
  const wrong = await get(loopback.port, '/?code=vieux&state=autre');
  assert.equal(wrong.status, 400);
  assert.match(wrong.body, /STATE/);
  const page = get(loopback.port, '/?code=neuf&state=bon-etat');
  assert.deepEqual(await loopback.wait, { code: 'neuf' });
  loopback.respond({ kind: 'ok', name: 'A' });
  await page;
});

test('loopback : refus sur la page Microsoft → DENIED, la page d’erreur est écrite par respond()', async (t) => {
  const loopback = await open(t);
  const page = get(loopback.port, '/?error=access_denied&error_description=refus&state=bon-etat');
  await assert.rejects(loopback.wait, { code: 'DENIED' });
  loopback.respond({ kind: 'error', code: 'DENIED' });
  const res = await page;
  assert.equal(res.status, 200);
  assert.match(res.body, /access|DENIED/);
});

test('loopback : vérification trop longue → page « retourne au launcher », onglet rechargé idem', async (t) => {
  const loopback = await open(t, { holdMs: 40 });
  const page = get(loopback.port, '/?code=abc&state=bon-etat');
  await loopback.wait;
  const res = await page;
  assert.equal(res.status, 200);
  assert.match(res.body, /class="wait"/);
  const again = await get(loopback.port, '/?code=abc&state=bon-etat');
  assert.match(again.body, /class="wait"/);
  loopback.respond({ kind: 'ok', name: 'A' }); // plus rien à écrire : ferme seulement
});

test('loopback : 10 minutes sans réponse → TIMEOUT et serveur fermé ; close() → CANCELLED', async (t) => {
  const late = await open(t, { waitMs: 30 });
  await assert.rejects(late.wait, { code: 'TIMEOUT' });
  await assert.rejects(get(late.port, '/?code=abc&state=bon-etat'), { code: 'ECONNREFUSED' });

  const cancelled = await open(t);
  cancelled.close();
  await assert.rejects(cancelled.wait, { code: 'CANCELLED' });
});

test('page de fin : pseudo et message échappés, langue de la page, pas de script', () => {
  const ok = loginPage({ kind: 'ok', name: '<img src=x>' });
  assert.match(ok, /&lt;img src=x&gt;/);
  assert.doesNotMatch(ok, /<img/);
  assert.match(ok, /<html lang="(fr|en|es)">/);
  const error = loginPage({ kind: 'error', code: 'XSTS_1', message: '<b>non</b>' });
  assert.match(error, /&lt;b&gt;non&lt;\/b&gt;/);
  assert.match(error, /XSTS_1/);
  for (const page of [ok, error, loginPage({ kind: 'pending' })]) assert.doesNotMatch(page, /<script|src="http|href="http/);
});

test('adresse d’autorisation : adresse de retour choisie, PKCE S256, state', () => {
  const native = new URL(microsoft.createAuthorization('client').url);
  assert.equal(native.searchParams.get('redirect_uri'), microsoft.REDIRECT_URI);
  const { url, verifier, state } = microsoft.createAuthorization('client', { redirectUri: 'http://localhost:53817' });
  const params = new URL(url).searchParams;
  assert.equal(params.get('redirect_uri'), 'http://localhost:53817');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.equal(params.get('state'), state);
  assert.ok(verifier.length >= 43);
});

/** Remplace fetch le temps d'un test : note les formulaires envoyés, répond « jeton expiré ». */
function fakeTokenEndpoint(t) {
  const forms = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    forms.push({ url: String(url), form: new URLSearchParams(init.body) });
    return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  };
  t.after(() => { globalThis.fetch = original; });
  return forms;
}

test('renouvellement et premier jeton : même adresse de retour que la connexion', async (t) => {
  const forms = fakeTokenEndpoint(t);
  await assert.rejects(microsoft.renew('client', 'r1', 'loopback'), { code: 'EXPIRED' });
  await assert.rejects(microsoft.renew('client', 'r2'), { code: 'EXPIRED' });
  await assert.rejects(microsoft.signIn('client', 'code', 'verifier', 'http://localhost:5000'), { code: 'EXPIRED' });
  assert.equal(forms[0].form.get('redirect_uri'), 'http://localhost');
  assert.equal(forms[1].form.get('redirect_uri'), microsoft.REDIRECT_URI);
  assert.equal(forms[2].form.get('redirect_uri'), 'http://localhost:5000');
  assert.equal(forms[2].form.get('grant_type'), 'authorization_code');
});

test('AccountStore : un compte connecté dans le navigateur garde redirect « loopback » pour ses renouvellements', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '0rzxn-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const session = (redirect) => ({ uuid: 'a'.repeat(32), name: 'Steve_42', xuid: '1', refreshToken: 'r', accessToken: 'x', expiresAt: Date.now() + 3_600_000, redirect });
  const store = new AccountStore(dir, {
    renew: async (refreshToken, redirect) => {
      calls.push(redirect);
      return session(redirect);
    },
  });
  store.addMicrosoft(session('loopback'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8')).accounts[0].redirect, 'loopback');
  await store.freshSecrets(store.get(`microsoft-${'a'.repeat(32)}`), () => {}, { force: true });
  assert.deepEqual(calls, ['loopback']);
  assert.equal(store.get(`microsoft-${'a'.repeat(32)}`).redirect, 'loopback');

  // Ancien compte (fenêtre intégrée) : pas de champ, renouvellement « native ».
  store.addMicrosoft(session('native'));
  assert.equal(store.get(`microsoft-${'a'.repeat(32)}`).redirect, undefined);
  await store.freshSecrets(store.get(`microsoft-${'a'.repeat(32)}`), () => {}, { force: true });
  assert.deepEqual(calls, ['loopback', 'native']);
});
