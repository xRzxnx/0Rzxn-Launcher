'use strict';

// ESLint minimal : seulement des règles qui repèrent de vraies erreurs (le style n'est pas contrôlé).
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  // Dossiers cachés à la racine : données de l'aperçu, outils locaux.
  { ignores: ['node_modules/', 'dist/', 'target/', 'crates/interface/dist/', 'Maquettes/', 'build/', '.*/', 'src/renderer/vendor/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: { ...globals.node } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      // Règles de style ou de goût, pas des erreurs : désactivées.
      'no-useless-assignment': 'off', // « let x = []; try { x = … } catch { continue; } »
      'preserve-caught-error': 'off',
      // Promesses : un exécuteur async perd ses erreurs.
      'no-async-promise-executor': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'off', // les fichiers de version Mojang utilisent ${...}
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',
      'no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
      'array-callback-return': ['error', { checkForEach: false }],
    },
  },
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    files: ['scripts/apercu.js', 'scripts/make-icon.js'],
    languageOptions: { globals: { ...globals.node } },
  },
];
