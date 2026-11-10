'use strict';

// core/net.js : HTTPS, redirections, délai d'inactivité, essais, Retry-After, limites — avec de faux serveurs locaux.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { t: tr } = require('../src/main/i18n');
const net = require('../src/main/core/net');

// Serveurs de test en clair sur 127.0.0.1 seulement ; attentes entre essais très courtes.
net.configure({ insecureHosts: ['127.0.0.1'], backoffBase: 1, concurrency: 16, perHost: 8 });

/** Serveur local : `handler(req, res, hit)` avec le numéro de la requête ; compte les requêtes et les connexions simultanées. */
async function serve(t, handler) {
  const stats = { hits: 0, active: 0, maxActive: 0, agents: [] };
  const server = http.createServer((req, res) => {
    stats.hits += 1;
    stats.active += 1;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    stats.agents.push(req.headers['user-agent']);
    res.on('close', () => { stats.active -= 1; });
    handler(req, res, stats.hits);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, stats };
}

const reply = (res, status, body = '', headers = {}) => {
  res.writeHead(status, headers);
  res.end(body);
};

test('secureUrl : http réécrit en https, autres protocoles refusés', () => {
  assert.equal(net.secureUrl('http://libraries.minecraft.net/a.jar').href, 'https://libraries.minecraft.net/a.jar');
  assert.equal(net.secureUrl('https://cdn.modrinth.com/x').protocol, 'https:');
  assert.equal(net.secureUrl('http://127.0.0.1:8080/x').protocol, 'http:'); // serveur de test autorisé
  assert.throws(() => net.secureUrl('ftp://example.org/a'), { message: tr('net.adresse_refusee', { url: 'ftp://example.org/a' }) });
  assert.throws(() => net.secureUrl('file:///C:/a'), (error) => error.code === 'NET_INSECURE');
});

test('retryAfterMs : secondes ou date HTTP', () => {
  assert.equal(net.retryAfterMs('3'), 3000);
  assert.equal(net.retryAfterMs(' 0 '), 0);
  assert.equal(net.retryAfterMs(new Date(10_000 + 5000).toUTCString(), 10_000), 5000);
  assert.equal(net.retryAfterMs(null), null);
  assert.equal(net.retryAfterMs('demain'), null);
});

test('backoffMs : au hasard, croissant, plafonné à 10 s', (t) => {
  t.after(() => net.configure({ backoffBase: 1 }));
  net.configure({ backoffBase: 500 });
  t.mock.method(Math, 'random', () => 0.999999);
  assert.ok(Math.abs(net.backoffMs(1) - 500) < 1);
  assert.ok(Math.abs(net.backoffMs(3) - 2000) < 1);
  assert.ok(Math.abs(net.backoffMs(10) - 10_000) < 1);
  Math.random.mock.mockImplementation(() => 0);
  assert.equal(net.backoffMs(4), 0);
});

test('fetchBuffer et fetchJson : corps reçu, User-Agent du launcher', async (t) => {
  const { base, stats } = await serve(t, (req, res) => reply(res, 200, JSON.stringify({ ok: true, path: req.url })));
  net.configure({ version: '9.9.9' });
  assert.deepEqual(await net.fetchJson(`${base}/a`), { ok: true, path: '/a' });
  assert.equal((await net.fetchBuffer(`${base}/b`)).toString(), JSON.stringify({ ok: true, path: '/b' }));
  assert.match(stats.agents[0], /^0Rzxn_Launcher\/9\.9\.9 \(\+https:\/\/github\.com\/xRzxnx\/0Rzxn-Launcher\)$/);
});

test('erreurs passagères : jusqu’à 4 essais, puis succès', async (t) => {
  const { base, stats } = await serve(t, (req, res, hit) => (hit < 4 ? reply(res, hit === 1 ? 503 : 500) : reply(res, 200, 'enfin')));
  assert.equal((await net.fetchBuffer(`${base}/x`)).toString(), 'enfin');
  assert.equal(stats.hits, 4);
});

test('erreur durable : abandon après 4 essais, message du statut', async (t) => {
  const { base, stats } = await serve(t, (req, res) => reply(res, 502));
  await assert.rejects(net.fetchBuffer(`${base}/x`), { message: tr('download.reponse_de', { status: 502, host: new URL(base).host }), status: 502 });
  assert.equal(stats.hits, 4);
});

test('404 : pas de nouvel essai', async (t) => {
  const { base, stats } = await serve(t, (req, res) => reply(res, 404));
  await assert.rejects(net.fetchBuffer(`${base}/absent`), { status: 404 });
  assert.equal(stats.hits, 1);
});

test('429 avec Retry-After : attente respectée', async (t) => {
  const { base, stats } = await serve(t, (req, res, hit) => (hit === 1 ? reply(res, 429, '', { 'Retry-After': '1' }) : reply(res, 200, 'ok')));
  const start = Date.now();
  assert.equal((await net.fetchBuffer(`${base}/x`)).toString(), 'ok');
  assert.ok(Date.now() - start >= 950, `attente trop courte : ${Date.now() - start} ms`);
  assert.equal(stats.hits, 2);
});

test('Retry-After trop long : erreur tout de suite, qui dit combien attendre', async (t) => {
  const { base, stats } = await serve(t, (req, res) => reply(res, 503, '', { 'Retry-After': '120' }));
  const start = Date.now();
  await assert.rejects(net.fetchBuffer(`${base}/x`), { message: tr('net.attendre_avant_de_reessayer', { host: new URL(base).host, seconds: 120 }) });
  assert.ok(Date.now() - start < 1000);
  assert.equal(stats.hits, 1);
});

test('redirections : suivies, mais jamais vers http:// ni plus de 5', async (t) => {
  const { base } = await serve(t, (req, res) => {
    if (req.url === '/ok') return reply(res, 302, '', { Location: '/fin' });
    if (req.url === '/fin') return reply(res, 200, 'arrivé');
    if (req.url === '/clair') return reply(res, 301, '', { Location: 'http://localhost/secret' });
    const n = Number(req.url.slice(1));
    return reply(res, 302, '', { Location: `/${n + 1}` });
  });
  assert.equal((await net.fetchBuffer(`${base}/ok`)).toString(), 'arrivé');
  await assert.rejects(net.fetchBuffer(`${base}/clair`), { message: tr('net.redirection_refusee', { host: 'localhost' }) });
  await assert.rejects(net.fetchBuffer(`${base}/1`), { message: tr('net.trop_de_redirections', { host: new URL(base).host }) });
});

test('délai d’inactivité : un serveur muet est abandonné, un serveur lent mais régulier va au bout', async (t) => {
  const { base, stats } = await serve(t, (req, res) => {
    res.writeHead(200);
    if (req.url === '/muet') return res.write('a'); // puis plus rien
    let n = 0;
    const timer = setInterval(() => {
      res.write('b');
      if (++n === 8) {
        clearInterval(timer);
        res.end();
      }
    }, 60);
  });
  // 8 × 60 ms = environ 500 ms au total, bien plus que le délai de 200 ms : seul le silence compte.
  assert.equal((await net.fetchBuffer(`${base}/lent`, { idleTimeout: 200 })).toString(), 'bbbbbbbb');
  const before = stats.hits;
  await assert.rejects(net.fetchBuffer(`${base}/muet`, { idleTimeout: 150 }), (error) => error.code === 'NET_IDLE');
  assert.equal(stats.hits - before, 4); // réessayé
});

test('limites : 3 connexions à la fois vers un serveur, 5 au total', async (t) => {
  t.after(() => net.configure({ concurrency: 16, perHost: 8 }));
  net.configure({ perHost: 3, concurrency: 5 });
  const slow = (req, res) => setTimeout(() => reply(res, 200, 'x'), 40);
  const one = await serve(t, slow);
  const two = await serve(t, slow);
  await Promise.all([
    ...Array.from({ length: 12 }, (_, i) => net.fetchBuffer(`${one.base}/${i}`)),
    ...Array.from({ length: 12 }, (_, i) => net.fetchBuffer(`${two.base}/${i}`)),
  ]);
  assert.equal(one.stats.hits, 12);
  assert.ok(one.stats.maxActive <= 3 && two.stats.maxActive <= 3, `par serveur : ${one.stats.maxActive}, ${two.stats.maxActive}`);
  assert.ok(one.stats.maxActive + two.stats.maxActive >= 4, 'les deux serveurs travaillent en même temps');
});

test('X-Ratelimit-Remaining à 0 : la requête suivante attend la remise à zéro', async (t) => {
  const { base, stats } = await serve(t, (req, res, hit) => reply(res, 200, 'x', hit === 1 ? { 'X-Ratelimit-Remaining': '0', 'X-Ratelimit-Reset': '1' } : {}));
  await net.fetchBuffer(`${base}/1`);
  const start = Date.now();
  await net.fetchBuffer(`${base}/2`);
  assert.ok(Date.now() - start >= 900, `attente : ${Date.now() - start} ms`);
  assert.equal(stats.hits, 2);
});

test('annulation : pendant l’attente entre deux essais, et pendant la lecture', async (t) => {
  const { base } = await serve(t, (req, res) => (req.url === '/attente' ? reply(res, 503, '', { 'Retry-After': '30' }) : (res.writeHead(200), res.write('a'))));
  const first = new AbortController();
  const waiting = net.fetchBuffer(`${base}/attente`, { signal: first.signal });
  setTimeout(() => first.abort(new Error('stop')), 100);
  const start = Date.now();
  await assert.rejects(waiting, { message: 'stop' });
  assert.ok(Date.now() - start < 2000);

  const second = new AbortController();
  const reading = net.fetchBuffer(`${base}/lecture`, { signal: second.signal });
  setTimeout(() => second.abort(new Error('stop 2')), 100);
  await assert.rejects(reading, { message: 'stop 2' });
});

test('request : réponse ouverte lue morceau par morceau, places rendues à la fermeture', async (t) => {
  t.after(() => net.configure({ perHost: 8 }));
  net.configure({ perHost: 1 });
  const { base } = await serve(t, (req, res) => reply(res, 200, 'abc'));
  const handle = await net.request(`${base}/a`);
  let body = '';
  for await (const chunk of handle.chunks()) body += Buffer.from(chunk).toString();
  assert.equal(body, 'abc');
  handle.close();
  handle.close(); // deux fois : sans effet
  // Avec une seule place par serveur, une deuxième requête n'aboutit que si la première l'a rendue.
  assert.equal((await net.fetchBuffer(`${base}/b`)).toString(), 'abc');
});
