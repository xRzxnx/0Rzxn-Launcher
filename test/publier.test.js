'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVersion } = require('../scripts/publier');

test('publier : versions stables et bêta', () => {
  assert.deepEqual(parseVersion('0.5.1'), { version: '0.5.1', tag: 'v0.5.1', beta: false });
  assert.deepEqual(parseVersion('0.6.0-beta.2'), { version: '0.6.0-beta.2', tag: 'v0.6.0-beta.2', beta: true });
  for (const bad of ['0.6', '0.6.0-rc.1', '0.6.0-beta', 'v0.6.0', '']) assert.equal(parseVersion(bad), null, bad);
});
