'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { osName, ruleAllows, parseMaven, mavenPath, nativeArchMatches } = require('../src/main/core/rules');

const other = osName() === 'windows' ? 'linux' : 'windows';

test('ruleAllows : sans règle, tout est permis', () => {
  assert.equal(ruleAllows(undefined), true);
  assert.equal(ruleAllows([]), true);
});

test('ruleAllows : la dernière règle qui correspond l’emporte', () => {
  assert.equal(ruleAllows([{ action: 'allow' }]), true);
  assert.equal(ruleAllows([{ action: 'allow' }, { action: 'disallow', os: { name: osName() } }]), false);
  assert.equal(ruleAllows([{ action: 'allow' }, { action: 'disallow', os: { name: other } }]), true);
  assert.equal(ruleAllows([{ action: 'allow', os: { name: other } }]), false);
});

test('ruleAllows : architecture et version du système', () => {
  const foreignArch = process.arch === 'ia32' ? 'arm64' : 'x86';
  assert.equal(ruleAllows([{ action: 'allow', os: { arch: foreignArch } }]), false);
  assert.equal(ruleAllows([{ action: 'allow', os: { name: osName(), version: '.*' } }]), true);
  // Une expression illisible ne correspond à rien (pas d'exception).
  assert.equal(ruleAllows([{ action: 'allow', os: { version: '([' } }]), false);
});

test('ruleAllows : fonctionnalités demandées', () => {
  const rules = [{ action: 'allow', features: { has_custom_resolution: true } }];
  assert.equal(ruleAllows(rules, { has_custom_resolution: true }), true);
  assert.equal(ruleAllows(rules, {}), false);
  assert.equal(ruleAllows([{ action: 'allow', features: { is_demo_user: false } }], {}), true);
});

test('mavenPath : groupe, classifieur et extension', () => {
  assert.equal(mavenPath('net.fabricmc:fabric-loader:0.17.2'), 'net/fabricmc/fabric-loader/0.17.2/fabric-loader-0.17.2.jar');
  assert.equal(mavenPath('org.lwjgl:lwjgl:3.3.3:natives-windows'), 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar');
  assert.equal(mavenPath('de.oceanlabs.mcp:mcp_config:1.20.1-20230612.114412@zip'), 'de/oceanlabs/mcp/mcp_config/1.20.1-20230612.114412/mcp_config-1.20.1-20230612.114412.zip');
  assert.deepEqual(parseMaven('a.b:c:1:d@txt'), { group: 'a.b', artifact: 'c', version: '1', classifier: 'd', ext: 'txt' });
});

test('nativeArchMatches : seules les natives de ce processeur', () => {
  assert.equal(nativeArchMatches(undefined), true);
  assert.equal(nativeArchMatches('sources'), true);
  assert.equal(nativeArchMatches('natives-windows'), true);
  assert.equal(nativeArchMatches('natives-windows-arm64'), process.arch === 'arm64');
  assert.equal(nativeArchMatches('natives-linux-aarch_64'), process.arch === 'arm64');
  assert.equal(nativeArchMatches('natives-windows-x86'), process.arch === 'ia32');
});
