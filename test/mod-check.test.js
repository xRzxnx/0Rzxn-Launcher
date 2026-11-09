'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchFabricRange, matchMavenRange } = require('../src/main/core/mod-check');

test('matchFabricRange : comparaisons simples', () => {
  assert.equal(matchFabricRange('>=1.20', '1.20.1'), true);
  assert.equal(matchFabricRange('>=1.20.2', '1.20.1'), false);
  assert.equal(matchFabricRange('<1.21', '1.20.6'), true);
  assert.equal(matchFabricRange('1.21.1', '1.21.1'), true);
  assert.equal(matchFabricRange('=1.21.1', '1.21'), false);
  assert.equal(matchFabricRange('*', '1.8.9'), true);
  assert.equal(matchFabricRange('', '1.8.9'), true);
});

test('matchFabricRange : plages combinées, alternatives et listes', () => {
  assert.equal(matchFabricRange('>=1.20 <1.21', '1.20.4'), true);
  assert.equal(matchFabricRange('>=1.20 <1.21', '1.21'), false);
  assert.equal(matchFabricRange('>= 1.20', '1.20.1'), true); // opérateur séparé par une espace
  assert.equal(matchFabricRange('1.20.1 || 1.20.4', '1.20.4'), true);
  assert.equal(matchFabricRange(['1.20.1', '1.20.2'], '1.20.2'), true);
  assert.equal(matchFabricRange(['1.20.1', '1.20.2'], '1.20.3'), false);
});

test('matchFabricRange : jokers, ~ et ^', () => {
  assert.equal(matchFabricRange('1.20.x', '1.20.4'), true);
  assert.equal(matchFabricRange('1.20.x', '1.21'), false);
  assert.equal(matchFabricRange('1.21.*', '1.21.1'), true);
  assert.equal(matchFabricRange('~1.20', '1.20.6'), true);
  assert.equal(matchFabricRange('~1.20', '1.21'), false);
  assert.equal(matchFabricRange('^1.2', '1.9'), true);
  assert.equal(matchFabricRange('^1.2', '2.0'), false);
});

test('matchFabricRange : suffixes de version ignorés', () => {
  assert.equal(matchFabricRange('>=0.15.0', '0.17.2+build.1'), true);
  assert.equal(matchFabricRange('>=1.21-beta.1', '1.21.1'), true);
});

test('matchFabricRange : null quand le format n’est pas compris', () => {
  assert.equal(matchFabricRange('^0.5', '0.5.3'), null);
  assert.equal(matchFabricRange('banane', '1.20.1'), null);
  assert.equal(matchFabricRange('>=1.20', undefined), null);
  assert.equal(matchFabricRange([42], '1.20.1'), null);
  // Une alternative comprise et vraie suffit.
  assert.equal(matchFabricRange('banane || 1.20.1', '1.20.1'), true);
});

test('matchMavenRange : intervalles ouverts et fermés', () => {
  assert.equal(matchMavenRange('[1.20,1.21)', '1.20.1'), true);
  assert.equal(matchMavenRange('[1.20,1.21)', '1.21'), false);
  assert.equal(matchMavenRange('[1.20,1.21]', '1.21'), true);
  assert.equal(matchMavenRange('(1.20,1.21)', '1.20'), false);
  assert.equal(matchMavenRange('[1.20.1,)', '1.21.4'), true);
  assert.equal(matchMavenRange('(,1.20]', '1.19.2'), true);
  assert.equal(matchMavenRange('(,1.20]', '1.20.1'), false);
});

test('matchMavenRange : version exacte et unions', () => {
  assert.equal(matchMavenRange('[1.21.1]', '1.21.1'), true);
  assert.equal(matchMavenRange('[1.21.1]', '1.21'), false);
  assert.equal(matchMavenRange('[1.18,1.19),[1.20,1.21)', '1.20.4'), true);
  assert.equal(matchMavenRange('[1.18,1.19),[1.20,1.21)', '1.19.2'), false);
  assert.equal(matchMavenRange('[47,)', '47.4.0'), true);
});

test('matchMavenRange : null quand le format n’est pas compris', () => {
  assert.equal(matchMavenRange('1.20.1', '1.20.1'), null);
  assert.equal(matchMavenRange('[1.20,1.21) et plus', '1.20.1'), null);
  assert.equal(matchMavenRange('[banane]', '1.20.1'), null);
  assert.equal(matchMavenRange('[1.20,1.21)', 'snapshot'), null);
  assert.equal(matchMavenRange(undefined, '1.20.1'), null);
});
