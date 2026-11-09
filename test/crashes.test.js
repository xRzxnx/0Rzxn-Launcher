'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnose, crashFile, scrub } = require('../src/main/core/crashes');

// Extraits reproduisant le texte réel des rapports (Fabric Loader, Forge, Java, HotSpot).
const ids = (result) => result.problems.map((p) => p.id);

test('diagnose : dépendance Fabric absente', () => {
  const log = [
    'net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!',
    'A potential solution has been determined, this may resolve your problem:',
    '\t - Install fabric-api, any version.',
    'More details:',
    "\t - Mod 'Mod Menu' (modmenu) 11.0.3 requires any version of fabric-api, which is missing!",
  ].join('\n');
  const { problems } = diagnose(log);
  assert.deepEqual(ids({ problems }), ['missing']);
  assert.deepEqual(problems[0].lines, [4]);
  assert.ok(problems[0].actions.some((a) => a.type === 'install' && a.slug === 'fabric-api'));
  assert.ok(problems[0].actions.some((a) => a.type === 'disable' && a.modId === 'modmenu'));
});

test('diagnose : mauvaise version d’une dépendance et de Minecraft (Fabric)', () => {
  const log = [
    "\t - Mod 'Iris' (iris) 1.7.0+mc1.20.4 requires version 0.5.8 or later of mod 'Sodium' (sodium), but only the wrong version is present: 0.5.3!",
    "\t - Mod 'Sodium' (sodium) 0.5.8+mc1.20.4 requires version 1.20.4 of 'Minecraft' (minecraft), but only the wrong version is present: 1.20.1!",
  ].join('\n');
  const { problems } = diagnose(log);
  assert.deepEqual(ids({ problems }), ['version', 'version']);
  assert.match(problems[0].title, /Sodium/);
  assert.match(problems[1].title, /1\.20\.4/);
  assert.ok(problems[1].actions.some((a) => a.type === 'disable' && a.modId === 'sodium'));
});

test('diagnose : mods déclarés incompatibles (Fabric)', () => {
  const { problems } = diagnose("\t - Mod 'Sodium' (sodium) 0.6.0 is incompatible with any version of mod 'OptiFabric' (optifabric)");
  assert.deepEqual(problems.map((p) => p.id), ['incompatible']);
  assert.deepEqual(problems[0].actions, [{ type: 'disable', modId: 'sodium', label: problems[0].actions[0].label }]);
});

test('diagnose : dépendance Forge absente ou de mauvaise version', () => {
  const log = [
    '[main/ERROR] [net.minecraftforge.fml.loading.ModSorter/LOADING]: Missing or unsupported mandatory dependencies:',
    "\tMod ID: 'geckolib', Requested by: 'mowziesmobs', Expected range: '[4.4.2,)', Actual version: '[MISSING]'",
    "\tMod ID: 'minecraft', Requested by: 'jei', Expected range: '[1.20.4]', Actual version: '1.20.1'",
  ].join('\n');
  const { problems } = diagnose(log);
  assert.deepEqual(problems.map((p) => p.id), ['missing', 'version']);
  assert.ok(problems[0].actions.some((a) => a.type === 'install' && a.slug === 'geckolib'));
  assert.match(problems[1].title, /1\.20\.4/);
});

test('diagnose : Java trop ancien (UnsupportedClassVersionError)', () => {
  const log = 'Exception in thread "main" java.lang.UnsupportedClassVersionError: net/minecraft/client/main/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 52.0';
  const { problems } = diagnose(log, { java: 8, javaMode: 'custom' });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].id, 'java');
  assert.match(problems[0].title, /21/);
  assert.deepEqual(problems[0].actions.map((a) => a.type), ['settings']);
});

test('diagnose : Java trop récent pour Forge 1.12 (URLClassLoader)', () => {
  const log = 'java.lang.ClassCastException: class jdk.internal.loader.ClassLoaders$AppClassLoader cannot be cast to class java.net.URLClassLoader';
  const { problems } = diagnose(log, { java: 17 });
  assert.equal(problems[0].id, 'java');
  assert.deepEqual(problems[0].actions.map((a) => a.type), ['mods']);
});

test('diagnose : mémoire (tas plein, réservation impossible, mémoire du PC)', () => {
  assert.deepEqual(diagnose('java.lang.OutOfMemoryError: Java heap space', { ram: 2 }).problems.map((p) => p.id), ['memory']);
  assert.deepEqual(diagnose('Error occurred during initialization of VM\nCould not reserve enough space for 8388608KB object heap').problems.map((p) => p.id), ['memory']);
  assert.deepEqual(diagnose('# There is insufficient memory for the Java Runtime Environment to continue.').problems.map((p) => p.id), ['memory']);
});

test('diagnose : plantage du pilote graphique dans un hs_err_pid', () => {
  const log = [
    '#',
    '# A fatal error has been detected by the Java Runtime Environment:',
    '#',
    '#  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=0x00007ffb1c2a4b3e, pid=12345, tid=6789',
    '#',
    '# JRE version: OpenJDK Runtime Environment Microsoft-9388422 (21.0.5+11) (build 21.0.5+11-LTS)',
    '# Problematic frame:',
    '# C  [atio6axx.dll+0x1a4b3e]',
  ].join('\n');
  const { problems } = diagnose(log);
  assert.deepEqual(problems.map((p) => p.id), ['gpu']);
  assert.match(problems[0].title, /AMD/);
  assert.deepEqual(problems[0].lines, [7]);
});

test('diagnose : OpenGL indisponible', () => {
  assert.deepEqual(diagnose('[Render thread/ERROR]: GLFW error 65542: WGL: The driver does not appear to support OpenGL').problems.map((p) => p.id), ['gpu']);
});

test('diagnose : mixin en échec et jar abîmé', () => {
  const mixin = diagnose('org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: An unexpected critical error was encountered\nCaused by: Mixin apply for mod sodium failed sodium.mixins.json:core.MixinWindow');
  assert.equal(mixin.problems[0].id, 'mixin');
  assert.ok(mixin.problems[0].actions.some((a) => a.type === 'disable' && a.modId === 'sodium'));

  const zip = diagnose('java.util.zip.ZipException: zip END header not found\n\tat cristal-1.2.0.jar');
  assert.equal(zip.problems[0].id, 'corrupt');
  assert.match(zip.problems[0].title, /cristal-1\.2\.0\.jar/);
});

test('diagnose : mods suspectés d’un rapport du jeu', () => {
  const report = [
    '---- Minecraft Crash Report ----',
    'Description: Rendering overlay',
    '',
    'java.lang.NullPointerException: Cannot invoke "Object.hashCode()" because "key" is null',
    '\tat java.base/java.util.HashMap.get(HashMap.java:556)',
    '',
    'Suspected Mods: Sodium (sodium), Iris (iris)',
  ].join('\n');
  const { problems, suspects } = diagnose(report);
  assert.deepEqual(suspects, [{ name: 'Sodium', modId: 'sodium' }, { name: 'Iris', modId: 'iris' }]);
  assert.equal(problems[0].id, 'suspect');
  assert.deepEqual(problems[0].actions.map((a) => a.modId), ['sodium', 'iris']);
});

test('diagnose : erreur inconnue', () => {
  const { problems, suspects } = diagnose('Description: Ticking entity\n\njava.lang.IllegalStateException: bizarre\nSuspected Mods: NONE');
  assert.deepEqual(suspects, []);
  assert.equal(problems[0].id, 'unknown');
  assert.match(problems[0].text, /IllegalStateException/);
  assert.deepEqual(problems[0].lines, [2, 0]);
});

test('diagnose : une même erreur répétée ne fait qu’un problème', () => {
  const { problems } = diagnose('java.lang.OutOfMemoryError: Java heap space\njava.lang.OutOfMemoryError: Java heap space');
  assert.equal(problems.length, 1);
  assert.deepEqual(problems[0].lines, [0, 1]);
});

test('crashFile : noms de fichiers refusés', () => {
  const dirs = { gameDir: 'C:/jeu', instanceDir: 'C:/instance' };
  assert.ok(crashFile(dirs, 'report', 'crash-2026-11-09_12.00.00-client.txt').endsWith('crash-2026-11-09_12.00.00-client.txt'));
  assert.throws(() => crashFile(dirs, 'report', '../crash-x.txt'));
  assert.throws(() => crashFile(dirs, 'report', 'options.txt'));
  assert.throws(() => crashFile(dirs, 'jvm', 'hs_err_pidabc.log'));
  assert.throws(() => crashFile(dirs, 'autre', 'crash-x.txt'));
});

test('scrub : jetons et arguments de session masqués', () => {
  const jwt = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;
  const out = scrub(`--accessToken secret123 --uuid abcd ${jwt}`);
  assert.ok(!out.includes('secret123'));
  assert.ok(!out.includes('abcd'));
  assert.ok(!out.includes(jwt));
});
