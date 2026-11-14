'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const { LaunchSession } = require('../src/main/core/launch');

function session() {
  const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arret-'));
  fs.mkdirSync(path.join(instanceDir, 'minecraft'));
  return new LaunchSession({ dirs: {}, instance: {}, instanceDir, account: null });
}

test('stop arrête aussi un jeu qui ignore la demande polie', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ok'); setInterval(() => {}, 1000)"]);
  await once(child.stdout, 'data'); // le gestionnaire SIGTERM est en place
  const s = session();
  s.child = child;
  s.stop(200);
  const [code, signal] = await once(child, 'exit');
  assert.ok(code !== null || signal !== null);
});

test("la partie se termine même si un programme lancé par le jeu garde ses sorties ouvertes", async () => {
  // Le « jeu » lance un petit-enfant qui hérite de ses sorties et vit 20 s, puis quitte tout de suite.
  const grandchild = "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit' }).unref()";
  const s = session();
  const started = Date.now();
  s.spawnGame(process.execPath, ['-e', grandchild]);
  const [{ code }] = await once(s, 'exit');
  assert.strictEqual(code, 0);
  assert.ok(Date.now() - started < 10_000);
});
