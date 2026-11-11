'use strict';

// Java personnalisé 32 ou 64 bits, d'après la sortie de `java -version` (phase 6).
const test = require('node:test');
const assert = require('node:assert/strict');
const { javaBits, JAVA_32_MAX_GB } = require('../src/main/core/java');

test('32 ou 64 bits d’après java -version', () => {
  const hotspot64 = 'java version "1.8.0_451"\nJava(TM) SE Runtime Environment (build 1.8.0_451-b10)\nJava HotSpot(TM) 64-Bit Server VM (build 25.451-b10, mixed mode)';
  const hotspot32 = 'java version "1.8.0_451"\nJava(TM) SE Runtime Environment (build 1.8.0_451-b10)\nJava HotSpot(TM) Client VM (build 25.451-b10, mixed mode, sharing)';
  const server32 = 'openjdk version "17.0.2"\nOpenJDK Runtime Environment (build 17.0.2+8)\nOpenJDK Server VM (build 17.0.2+8, mixed mode)';
  const openj9 = 'openjdk version "17.0.9"\nIBM Semeru Runtime Open Edition (build 17.0.9+9)\nEclipse OpenJ9 VM (build openj9-0.41.0, JRE 17 Windows 11 amd64-64-Bit Compressed References 20231017_547 (JIT enabled, AOT enabled)';
  assert.equal(javaBits(hotspot64), 64);
  assert.equal(javaBits(hotspot32), 32);
  assert.equal(javaBits(server32), 32);
  assert.equal(javaBits(openj9), 64);
  assert.equal(javaBits('version "21"'), null); // inconnu : aucun refus
  assert.equal(JAVA_32_MAX_GB, 1.5);
});
