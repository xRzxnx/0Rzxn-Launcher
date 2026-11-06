'use strict';

// Contrôle des traductions : npm run check:i18n.
// Refuse les clés manquantes ou inutilisées, les variables qui diffèrent d'une langue à l'autre,
// et tout texte français resté dans le code (les commentaires, eux, restent en français).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LANGS = ['fr', 'en', 'es'];
const PARTS = {
  interface: { dir: 'src/renderer/js', locales: 'src/renderer/js/locales', skip: ['locales', 'assets'] },
  principal: { dir: 'src/main', locales: 'src/main/i18n', skip: ['i18n', 'assets'] },
};
// Textes français volontaires : le nom de la langue, et le test d'élision de recap-actions.js.
const ALLOWED = [/'Français'/, /aeiouhéèêàâîôû/];

function sourceFiles(dir, skip) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return skip.includes(entry.name) ? [] : sourceFiles(full, skip);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function loadDictionary(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^'use strict';/, '').replace('export default', 'module.exports =');
  const module = { exports: {} };
  new Function('module', text)(module);
  return module.exports;
}

/** Retire les commentaires, ligne par ligne : ils restent en français. */
function stripComments(source) {
  return source
    .split('\n')
    .map((line) => (/^\s*(\/\/|\/\*|\*)/.test(line) ? '' : line.replace(/\s\/\/ .*$/, '')))
    .join('\n');
}

const variables = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const forms = (value) => (typeof value === 'string' ? { '': value } : value);

const errors = [];
for (const [name, part] of Object.entries(PARTS)) {
  const dicts = Object.fromEntries(LANGS.map((lang) => [lang, loadDictionary(path.join(ROOT, part.locales, `${lang}.js`))]));
  // i18n.js et i18n/index.js utilisent aussi des clés (les unités) ; ils n'ont pas de texte français.
  const files = [...sourceFiles(path.join(ROOT, part.dir), part.skip), ...(name === 'principal' ? [path.join(ROOT, 'src/main/i18n/index.js')] : [])];
  const code = files.map((f) => ({ file: path.relative(ROOT, f), text: stripComments(fs.readFileSync(f, 'utf8')) }));
  const all = code.map((c) => c.text).join('\n');

  for (const m of all.matchAll(/\bt\(\s*'([\w.]+)'/g)) {
    if (!(m[1] in dicts.fr)) errors.push(`${name} : clé inconnue ${m[1]}`);
  }
  for (const key of Object.keys(dicts.fr)) {
    if (!all.includes(`'${key}'`)) errors.push(`${name} : clé inutilisée ${key}`);
    for (const lang of ['en', 'es']) {
      if (!(key in dicts[lang])) {
        errors.push(`${name} : ${key} manque en ${lang}`);
        continue;
      }
      if (typeof dicts.fr[key] !== typeof dicts[lang][key]) errors.push(`${name} : ${key} n'a pas la même forme en ${lang}`);
      const reference = forms(dicts.fr[key]);
      const translated = forms(dicts[lang][key]);
      for (const form of Object.keys(reference)) {
        if (variables(reference[form]) !== variables(translated[form] ?? '')) errors.push(`${name} : variables différentes pour ${key} en ${lang}`);
      }
    }
  }
  for (const lang of ['en', 'es']) {
    for (const key of Object.keys(dicts[lang])) if (!(key in dicts.fr)) errors.push(`${name} : ${key} en trop en ${lang}`);
  }
  for (const { file, text } of code) {
    text.split('\n').forEach((line, index) => {
      if (/[àâçéèêëîïôöùûœ«»’]/i.test(line) && !ALLOWED.some((re) => re.test(line))) errors.push(`${file}:${index + 1} : texte français dans le code : ${line.trim().slice(0, 90)}`);
    });
  }
}

if (errors.length) {
  console.log(errors.join('\n'));
  console.log(`\n${errors.length} problème(s).`);
  process.exit(1);
}
console.log('Traductions complètes : fr, en, es.');
