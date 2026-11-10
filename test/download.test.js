'use strict';

// core/download.js : écriture au fil de l'eau, empreintes, reprise des gros fichiers — avec de faux serveurs locaux.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { t: tr } = require('../src/main/i18n');
const net = require('../src/main/core/net');
const { downloadFile } = require('../src/main/core/download');

net.configure({ insecureHosts: ['127.0.0.1'], backoffBase: 1 });

const BIG = crypto.randomBytes(5 * 1024 * 1024 + 123); // au-dessus du seuil de reprise (4 Mo)
const SMALL = Buffer.from('petit fichier de test');
const hash = (data, algorithm = 'sha1') => crypto.createHash(algorithm).update(data).digest('hex');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '0rzxn-dl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Serveur qui sert `data` et note chaque requête (en-tête Range compris). `cut(hit)` : octets envoyés avant de couper. */
async function serve(t, data, { cut = () => null, ignoreRange = false, status = 200 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ range: req.headers.range ?? null });
    if (status !== 200) {
      res.writeHead(status);
      return res.end();
    }
    const range = !ignoreRange && /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    const body = data.subarray(start);
    res.writeHead(range ? 206 : 200, {
      'Content-Length': body.length,
      ...(range ? { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` } : {}),
    });
    const limit = cut(requests.length);
    if (limit == null) return res.end(body);
    res.write(body.subarray(0, limit), () => setTimeout(() => res.socket.destroy(), 20));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}/fichier`, requests };
}

test('petit fichier : écrit, sans .part laissé ; déjà présent, pas retéléchargé', async (t) => {
  const dir = tempDir(t);
  const { url, requests } = await serve(t, SMALL);
  const task = { url, path: path.join(dir, 'a', 'petit.txt'), sha1: hash(SMALL), size: SMALL.length };
  const seen = [];
  assert.equal(await downloadFile(task, { onBytes: (n) => seen.push(n) }), true);
  assert.deepEqual(fs.readFileSync(task.path), SMALL);
  assert.equal(fs.existsSync(`${task.path}.part`), false);
  assert.equal(seen.at(-1), SMALL.length);
  assert.equal(await downloadFile(task), false);
  assert.equal(requests.length, 1);
});

test('SHA-512 et SHA-1 vérifiés : un fichier faux est refusé après un second essai complet', async (t) => {
  const dir = tempDir(t);
  const { url, requests } = await serve(t, SMALL);
  const target = path.join(dir, 'faux.txt');
  await assert.rejects(downloadFile({ url, path: target, sha512: hash(Buffer.from('autre'), 'sha512') }), { message: tr('download.fichier_corrompu_sha512', { path: 'faux.txt' }) });
  assert.equal(requests.length, 2);
  await assert.rejects(downloadFile({ url, path: target, sha1: 'f'.repeat(40), sha512: hash(SMALL, 'sha512') }), { message: tr('download.fichier_corrompu_sha', { path: 'faux.txt' }) });
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(`${target}.part`), false);
  assert.equal(await downloadFile({ url, path: target, sha1: hash(SMALL), sha512: hash(SMALL, 'sha512') }), true);
});

test('taille inattendue : refusée', async (t) => {
  const dir = tempDir(t);
  const { url } = await serve(t, SMALL);
  await assert.rejects(downloadFile({ url, path: path.join(dir, 'x.txt'), size: SMALL.length - 3 }), { message: tr('download.taille_inattendue_pour', { path: 'x.txt' }) });
});

test('gros fichier coupé en route : reprise là où il s’était arrêté', async (t) => {
  const dir = tempDir(t);
  const { url, requests } = await serve(t, BIG, { cut: (hit) => (hit === 1 ? 2 * 1024 * 1024 : null) });
  const task = { url, path: path.join(dir, 'gros.bin'), sha1: hash(BIG), size: BIG.length };
  const seen = [];
  assert.equal(await downloadFile(task, { onBytes: (n) => seen.push(n) }), true);
  assert.equal(hash(fs.readFileSync(task.path)), hash(BIG));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].range, null);
  const resumedAt = Number(/^bytes=(\d+)-$/.exec(requests[1].range)?.[1]);
  assert.ok(resumedAt >= 1024 * 1024 && resumedAt <= 2 * 1024 * 1024, `reprise à ${resumedAt}`);
  assert.equal(seen.at(-1), BIG.length);
  assert.ok(seen.every((n, i) => i === 0 || n >= seen[i - 1] || n === resumedAt), 'progression sans retour en arrière sauf à la reprise');
});

test('serveur qui ignore Range : le fichier repart de zéro et arrive entier', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'gros.bin');
  fs.writeFileSync(`${target}.part`, BIG.subarray(0, 3 * 1024 * 1024));
  const { url, requests } = await serve(t, BIG, { ignoreRange: true });
  assert.equal(await downloadFile({ url, path: target, sha1: hash(BIG), size: BIG.length }), true);
  assert.equal(hash(fs.readFileSync(target)), hash(BIG));
  assert.equal(requests.length, 2); // demande avec Range (réponse 200 ignorée), puis demande entière
  assert.ok(requests[0].range && !requests[1].range);
});

test('.part abîmé : la reprise donne une empreinte fausse, le fichier repart de zéro', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'gros.bin');
  fs.writeFileSync(`${target}.part`, crypto.randomBytes(1024 * 1024));
  const { url, requests } = await serve(t, BIG);
  assert.equal(await downloadFile({ url, path: target, sha512: hash(BIG, 'sha512'), size: BIG.length }), true);
  assert.equal(hash(fs.readFileSync(target)), hash(BIG));
  assert.deepEqual(requests.map((r) => Boolean(r.range)), [true, false]);
});

test('petit fichier coupé : recommence de zéro (pas de reprise sous 4 Mo)', async (t) => {
  const dir = tempDir(t);
  const data = crypto.randomBytes(512 * 1024);
  const { url, requests } = await serve(t, data, { cut: (hit) => (hit === 1 ? 100 * 1024 : null) });
  assert.equal(await downloadFile({ url, path: path.join(dir, 'p.bin'), sha1: hash(data), size: data.length }), true);
  assert.deepEqual(requests.map((r) => r.range), [null, null]);
});

test('404 : pas de nouvel essai, rien d’écrit', async (t) => {
  const dir = tempDir(t);
  const { url, requests } = await serve(t, SMALL, { status: 404 });
  const target = path.join(dir, 'absent.txt');
  await assert.rejects(downloadFile({ url, path: target }), { status: 404 });
  assert.equal(requests.length, 1);
  assert.equal(fs.existsSync(target), false);
});

test('annulation pendant l’écriture : erreur rendue, pas de fichier final', async (t) => {
  const dir = tempDir(t);
  const { url } = await serve(t, BIG, { cut: () => 1024 * 1024 }); // jamais fini
  const target = path.join(dir, 'gros.bin');
  const controller = new AbortController();
  const running = downloadFile({ url, path: target, sha1: hash(BIG), size: BIG.length }, { signal: controller.signal, onBytes: (n) => n > 0 && controller.abort(new Error('stop')) });
  await assert.rejects(running, { message: 'stop' });
  assert.equal(fs.existsSync(target), false);
});

test('même fichier demandé deux fois en même temps : un seul téléchargement', async (t) => {
  const dir = tempDir(t);
  const { url, requests } = await serve(t, SMALL);
  const task = { url, path: path.join(dir, 'double.txt'), sha1: hash(SMALL), size: SMALL.length };
  const [a, b] = await Promise.all([downloadFile(task), downloadFile({ ...task })]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(requests.length, 1);
});

test('speedMeter : moyenne sur les 3 dernières secondes, rien avant une demi-seconde', () => {
  let now = 0;
  const meter = require('../src/main/core/download').speedMeter({ now: () => now });
  assert.equal(meter.sample(0), null);
  now = 400;
  assert.equal(meter.sample(400_000), null);
  now = 1000;
  assert.equal(meter.sample(1_000_000), 1_000_000); // 1 Mo en 1 s
  now = 5000;
  assert.equal(meter.sample(1_000_000), 0); // plus rien reçu depuis 4 s
});

test('downloadAll : octets à leur arrivée, vitesse, temps restant ; un fichier déjà présent compte sans fausser la vitesse', async (t) => {
  const dir = tempDir(t);
  const data = crypto.randomBytes(256 * 1024);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': data.length });
    let sent = 0;
    const timer = setInterval(() => {
      res.write(data.subarray(sent, sent + 32 * 1024));
      sent += 32 * 1024;
      if (sent >= data.length) {
        clearInterval(timer);
        res.end();
      }
    }, 100); // 8 morceaux : environ 0,8 s par fichier
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/f`;
  const present = path.join(dir, 'deja.bin');
  fs.writeFileSync(present, data);
  const tasks = [
    { url, path: present, sha1: hash(data), size: data.length },
    { url, path: path.join(dir, 'a.bin'), sha1: hash(data), size: data.length },
    { url, path: path.join(dir, 'b.bin'), sha1: hash(data), size: data.length },
  ];
  const reports = [];
  await require('../src/main/core/download').downloadAll(tasks, { concurrency: 2, onProgress: (p) => reports.push(p) });
  const last = reports.at(-1);
  assert.deepEqual([last.done, last.total, last.doneBytes, last.totalBytes], [3, 3, 3 * data.length, 3 * data.length]);
  const middle = reports.filter((p) => p.doneBytes > data.length && p.doneBytes < 3 * data.length);
  assert.ok(middle.length >= 3, 'des octets arrivent avant la fin des fichiers');
  const withSpeed = reports.filter((p) => p.speed != null);
  assert.ok(withSpeed.length > 0, 'vitesse mesurée');
  // Deux fichiers de 256 Ko en environ 0,8 s : bien moins que si le fichier déjà présent comptait comme reçu.
  assert.ok(withSpeed.every((p) => p.speed < 3 * data.length), `vitesse : ${withSpeed.map((p) => Math.round(p.speed)).join(', ')}`);
  assert.ok(withSpeed.some((p) => p.eta != null && p.eta >= 0));
  assert.ok(reports.every((p, i) => i === 0 || p.doneBytes >= reports[i - 1].doneBytes));
});
