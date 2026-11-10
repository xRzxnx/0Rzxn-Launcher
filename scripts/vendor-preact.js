'use strict';

// Copie Preact (module ES, sans dépendance) dans src/renderer/vendor/, pour l'interface sans étape de compilation.
// À relancer après une mise à jour de la version de preact dans package.json : node scripts/vendor-preact.js
// Seul le cœur est copié : l'interface n'utilise ni les hooks ni compat.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'node_modules', 'preact', 'package.json'));
const source = fs.readFileSync(path.join(root, 'node_modules', 'preact', 'dist', 'preact.mjs'), 'utf8');
if (/\bimport\b[^;]*\bfrom\b/.test(source)) throw new Error('preact.mjs imports another module: the vendored copy would not load');

const header = [
  `// Preact ${pkg.version} (https://preactjs.com), MIT License, Copyright (c) 2015-present Jason Miller.`,
  '// Copied by scripts/vendor-preact.js from node_modules/preact/dist/preact.mjs: do not edit.',
  '',
].join('\n');
const body = source.replace(/\n?\/\/# sourceMappingURL=.*\s*$/, '\n');
const target = path.join(root, 'src', 'renderer', 'vendor', 'preact.js');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, header + body);
console.log(`Preact ${pkg.version} -> ${path.relative(root, target)} (${fs.statSync(target).size} bytes)`);
