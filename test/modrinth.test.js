'use strict';

// core/modrinth.js passe par net.js : mêmes messages qu'avant, avec essais et User-Agent du projet — faux serveur local.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { t: tr } = require('../src/main/i18n');

const replies = []; // réponses à servir dans l'ordre : [statut, corps, en-têtes]
const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, agent: req.headers['user-agent'], method: req.method });
  const [status, body, headers] = replies.shift() ?? [500, '', {}];
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body);
});

let modrinth;
test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.LAUNCHER_MODRINTH_API = `http://127.0.0.1:${server.address().port}/v2`;
  const net = require('../src/main/core/net');
  net.configure({ insecureHosts: ['127.0.0.1'], backoffBase: 1, version: '1.2.3' });
  modrinth = require('../src/main/core/modrinth');
});
test.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
test.beforeEach(() => {
  replies.splice(0);
  seen.splice(0);
});

const VERSION = {
  id: 'v1', project_id: 'p1', name: 'Sodium 1', version_number: '1.0', version_type: 'release', date_published: '2026-01-01',
  loaders: ['fabric'], game_versions: ['1.21.11'], dependencies: [],
  files: [{ url: 'https://cdn.modrinth.com/a.jar', filename: 'a.jar', primary: true, size: 10, hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) } }],
};

test('version : SHA-1 et SHA-512 transmis, User-Agent du projet', async () => {
  replies.push([200, JSON.stringify(VERSION)]);
  const v = await modrinth.version('v1');
  assert.deepEqual(v.file, { url: 'https://cdn.modrinth.com/a.jar', filename: 'a.jar', sha1: 'a'.repeat(40), sha512: 'b'.repeat(128), size: 10 });
  assert.equal(seen[0].url, '/v2/version/v1');
  assert.match(seen[0].agent, /^0Rzxn_Launcher\/1\.2\.3 /);
});

test('erreur passagère : réessayée, la réponse arrive', async () => {
  replies.push([502, ''], [503, '', { 'Retry-After': '0' }], [200, JSON.stringify(VERSION)]);
  assert.equal((await modrinth.version('v1')).id, 'v1');
  assert.equal(seen.length, 3);
});

test('mêmes messages qu’avant : trop de requêtes, réponse inattendue, pas de réponse', async () => {
  for (let i = 0; i < 4; i++) replies.push([429, '', { 'Retry-After': '0' }]);
  await assert.rejects(modrinth.version('v1'), { message: tr('modrinth.trop_de_requetes_vers_modrinth') });
  assert.equal(seen.length, 4);

  replies.push([403, '']);
  await assert.rejects(modrinth.version('v1'), { message: tr('modrinth.modrinth_repondu', { status: 403 }) });
  assert.equal(seen.length, 5); // 403 : pas de nouvel essai
});

test('404 : null, comme avant (pas de nouvel essai)', async () => {
  replies.push([404, '']);
  assert.equal(await modrinth.versionsByHash(['c'.repeat(40)]).then(() => 'objet', () => 'erreur'), 'objet');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'POST');
});

test('serveur injoignable : « Modrinth ne répond pas »', async (t) => {
  const net = require('../src/main/core/net');
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  // Une autre adresse d'API : on recharge le module avec la variable changée.
  const saved = process.env.LAUNCHER_MODRINTH_API;
  process.env.LAUNCHER_MODRINTH_API = `http://127.0.0.1:${port}/v2`;
  delete require.cache[require.resolve('../src/main/core/modrinth')];
  t.after(() => {
    process.env.LAUNCHER_MODRINTH_API = saved;
    delete require.cache[require.resolve('../src/main/core/modrinth')];
  });
  net.configure({ backoffBase: 1 });
  const offline = require('../src/main/core/modrinth');
  await assert.rejects(offline.version('v1'), (error) => error.message.startsWith(tr('modrinth.modrinth_ne_repond_pas', { code: 'X' }).split('X')[0]));
});
