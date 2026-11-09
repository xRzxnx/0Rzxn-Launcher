'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveGc, jvmArguments, ramGuide, zgcArgs, userChoosesGc } = require('../src/main/core/performance');

test('resolveGc : choix automatique', () => {
  assert.equal(resolveGc({ javaMajor: 21, ramGb: 8, cpus: 16 }), 'zgc');
  assert.equal(resolveGc({ javaMajor: 21, ramGb: 8, cpus: 4 }), 'g1'); // trop peu de cœurs
  assert.equal(resolveGc({ javaMajor: 21, ramGb: 4, cpus: 16 }), 'g1'); // tas trop petit
  assert.equal(resolveGc({ javaMajor: 17, ramGb: 8, cpus: 16 }), 'g1'); // ZGC générationnel : Java 21
});

test('resolveGc : choix imposé', () => {
  assert.equal(resolveGc({ preset: 'zgc', javaMajor: 21, ramGb: 2, cpus: 2 }), 'zgc');
  assert.equal(resolveGc({ preset: 'zgc', javaMajor: 17, ramGb: 8, cpus: 16 }), 'g1');
  assert.equal(resolveGc({ preset: 'g1', javaMajor: 25, ramGb: 16, cpus: 32 }), 'g1');
  assert.equal(resolveGc({ preset: 'none', javaMajor: 21, ramGb: 8, cpus: 16 }), 'none');
  // L'utilisateur choisit déjà son ramasse-miettes.
  assert.equal(resolveGc({ javaMajor: 21, ramGb: 8, cpus: 16, jvmArgs: '-XX:+UseShenandoahGC' }), 'none');
  assert.equal(userChoosesGc('-Xss2M'), false);
  assert.equal(userChoosesGc(undefined), false);
});

test('zgcArgs : selon la version de Java', () => {
  assert.deepEqual(zgcArgs(21), ['-XX:+UseZGC', '-XX:+ZGenerational']);
  assert.deepEqual(zgcArgs(23), ['-XX:+UseZGC']);
  assert.deepEqual(zgcArgs(25), ['-XX:+UseZGC', '-XX:+UseCompactObjectHeaders']);
});

test('jvmArguments : tas et ramasse-miettes', () => {
  const g1 = jvmArguments({ preset: 'g1', javaMajor: 17, ramGb: 4 });
  assert.equal(g1.gc, 'g1');
  assert.deepEqual(g1.args.slice(0, 3), ['-Xmx4096M', '-Xms4096M', '-XX:+UseG1GC']);
  assert.ok(g1.args.includes('-XX:+AlwaysPreTouch'));

  const zgc = jvmArguments({ preset: 'auto', javaMajor: 25, ramGb: 8, cpus: 16 });
  assert.equal(zgc.gc, 'zgc');
  assert.ok(zgc.args.includes('-XX:+UseCompactObjectHeaders'));
  assert.ok(!zgc.args.includes('-XX:+UseG1GC'));

  assert.deepEqual(jvmArguments({ preset: 'none', javaMajor: 21, ramGb: 6 }).args, ['-Xmx6144M', '-Xms1024M']);
  assert.deepEqual(jvmArguments({ preset: 'none', javaMajor: 8, ramGb: 0.5 }).args, ['-Xmx512M', '-Xms512M']);
  assert.deepEqual(jvmArguments({ javaMajor: 21, ramGb: 3.5, jvmArgs: '-XX:+UseParallelGC' }), { gc: 'none', args: ['-Xmx3584M', '-Xms3584M'] });
});

test('ramGuide : selon l’instance', () => {
  assert.deepEqual(ramGuide({ loader: 'vanilla', version: '1.21.4', totalGb: 32 }), { min: 2, low: 3, high: 4, cap: 19, limited: false, ideal: 4 });
  assert.deepEqual(ramGuide({ loader: 'vanilla', version: '1.8.9', totalGb: 32 }).high, 3);
  assert.deepEqual(ramGuide({ loader: 'vanilla', version: 'b1.7.3', totalGb: 32 }).high, 3);
  assert.equal(ramGuide({ loader: 'fabric', mods: 20, totalGb: 32 }).high, 6);
  assert.equal(ramGuide({ loader: 'fabric', mods: 80, totalGb: 32 }).high, 8);
  assert.equal(ramGuide({ loader: 'forge', mods: 150, totalGb: 32 }).high, 10);
  assert.equal(ramGuide({ loader: 'neoforge', mods: 250, totalGb: 32 }).high, 12);
  // Shaders et ZGC : un Go de plus chacun.
  assert.deepEqual(ramGuide({ loader: 'fabric', mods: 80, shaders: 2, zgc: true, totalGb: 32 }), { min: 7, low: 8, high: 10, cap: 19, limited: false, ideal: 9 });
});

test('ramGuide : selon le PC', () => {
  const small = ramGuide({ loader: 'forge', mods: 150, totalGb: 8 });
  assert.equal(small.cap, 4.5);
  assert.equal(small.limited, true);
  assert.equal(small.high, 4.5);
  assert.equal(small.low, 4.5);
  // Carte graphique intégrée : la moitié de la RAM seulement.
  assert.equal(ramGuide({ loader: 'forge', mods: 150, totalGb: 8, integrated: true }).cap, 4);
  // Jamais moins de 2 Go de plafond, ni moins de 1,5 Go de minimum.
  const tiny = ramGuide({ loader: 'vanilla', version: '1.21', totalGb: 2 });
  assert.equal(tiny.cap, 2);
  assert.equal(tiny.min, 1.5);
});
