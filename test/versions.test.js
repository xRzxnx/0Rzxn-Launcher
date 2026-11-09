'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeVersions } = require('../src/main/core/versions');

// Fichier vanilla moderne et fichier de loader qui en hérite (forme des fichiers Fabric).
const VANILLA = {
  id: '1.21.1',
  type: 'release',
  mainClass: 'net.minecraft.client.main.Main',
  javaVersion: { majorVersion: 21 },
  libraries: [{ name: 'com.mojang:brigadier:1.3.10' }],
  arguments: { game: ['--username', '${auth_player_name}'], jvm: ['-cp', '${classpath}'] },
  downloads: { client: { url: 'https://exemple/client.jar' } },
};

const FABRIC = {
  id: 'fabric-loader-0.17.2-1.21.1',
  inheritsFrom: '1.21.1',
  mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
  libraries: [{ name: 'net.fabricmc:fabric-loader:0.17.2' }],
  arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
};

test('mergeVersions : l’enfant l’emporte, ses bibliothèques passent en premier', () => {
  const merged = mergeVersions(VANILLA, FABRIC);
  assert.equal(merged.id, FABRIC.id);
  assert.equal(merged.mainClass, FABRIC.mainClass);
  assert.equal(merged.javaVersion.majorVersion, 21);
  assert.deepEqual(merged.downloads, VANILLA.downloads);
  assert.deepEqual(merged.libraries.map((l) => l.name), ['net.fabricmc:fabric-loader:0.17.2', 'com.mojang:brigadier:1.3.10']);
  assert.equal('inheritsFrom' in merged, false);
});

test('mergeVersions : arguments du parent puis de l’enfant', () => {
  const merged = mergeVersions(VANILLA, FABRIC);
  assert.deepEqual(merged.arguments.game, ['--username', '${auth_player_name}']);
  assert.deepEqual(merged.arguments.jvm, ['-cp', '${classpath}', '-DFabricMcEmu= net.minecraft.client.main.Main ']);
});

test('mergeVersions : le jar porte le nom de l’enfant, sauf s’il en désigne un', () => {
  assert.equal(mergeVersions(VANILLA, FABRIC).jar, FABRIC.id);
  assert.equal(mergeVersions(VANILLA, { ...FABRIC, jar: '1.21.1' }).jar, '1.21.1');
});

test('mergeVersions : format ancien (minecraftArguments), sans tableau d’arguments', () => {
  const parent = { id: '1.12.2', minecraftArguments: '--username ${auth_player_name}', libraries: [{ name: 'a:b:1' }] };
  const child = { id: '1.12.2-forge', inheritsFrom: '1.12.2', minecraftArguments: '--username ${auth_player_name} --tweakClass x', libraries: [{ name: 'c:d:2' }] };
  const merged = mergeVersions(parent, child);
  assert.equal(merged.arguments, undefined);
  assert.equal(merged.minecraftArguments, child.minecraftArguments);
  assert.deepEqual(merged.libraries.map((l) => l.name), ['c:d:2', 'a:b:1']);
});

test('mergeVersions : ne modifie pas les fichiers d’origine', () => {
  const parent = structuredClone(VANILLA);
  const child = structuredClone(FABRIC);
  mergeVersions(parent, child);
  assert.deepEqual(parent, VANILLA);
  assert.deepEqual(child, FABRIC);
});
