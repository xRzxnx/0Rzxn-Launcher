'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const { LaunchSession } = require('../src/main/core/launch');

test('stop arrête aussi un jeu qui ignore la demande polie', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ok'); setInterval(() => {}, 1000)"]);
  await once(child.stdout, 'data'); // le gestionnaire SIGTERM est en place
  const session = Object.create(LaunchSession.prototype);
  session.child = child;
  session.stop(200);
  const [code, signal] = await once(child, 'exit');
  assert.ok(code !== null || signal !== null);
});
