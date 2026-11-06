'use strict';

// Messages du processus principal : erreurs renvoyées à l'interface, dialogues Windows, zone de notification.
// Ce module ne dépend pas d'Electron : la langue lui est donnée par main.js.

const SUPPORTED = ['fr', 'en', 'es'];
const FALLBACK = 'en';
const LOCALES = { fr: 'fr-FR', en: 'en-US', es: 'es-ES' };

let lang = 'fr';
let locale = LOCALES.fr;
let dict = require('./fr.js');
let rules = new Intl.PluralRules(locale);

/**
 * Langue à utiliser. `pref` vaut 'auto' ou un code de langue ; en automatique, on prend la première
 * langue préférée de Windows que le launcher connaît (fr-CA compte pour fr), sinon l'anglais.
 * Les formats suivent la région de Windows quand elle va avec cette langue (en-GB plutôt qu'en-US).
 */
function resolveLanguage(pref, systemLanguages = []) {
  const base = (tag) => String(tag).toLowerCase().split(/[-_]/)[0];
  const chosen = SUPPORTED.includes(pref) ? pref : systemLanguages.map(base).find((code) => SUPPORTED.includes(code)) ?? FALLBACK;
  const regional = systemLanguages.find((tag) => base(tag) === chosen && String(tag).includes('-'));
  return { lang: chosen, locale: regional ?? LOCALES[chosen] };
}

function setLanguage(next) {
  dict = require(`./${next.lang}.js`);
  lang = next.lang;
  locale = next.locale;
  rules = new Intl.PluralRules(locale);
}

const num = (value, options) => new Intl.NumberFormat(locale, options).format(value);
const gb = (value) => `${num(Number(value))} ${t('unit.gb')}`;
const compareText = (a, b, options) => a.localeCompare(b, locale, options);
const formatDate = (date, options) => new Intl.DateTimeFormat(locale, options).format(date);
const currentLanguage = () => lang;

/** Texte de la clé `key` : variables {nom}, et pluriel { one, other } selon vars.count. */
function t(key, vars) {
  let text = dict[key];
  if (text === undefined) return key;
  if (typeof text === 'object') text = text[rules.select(vars.count)] ?? text.other;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => {
    if (!(name in vars)) return match;
    return name === 'count' && typeof vars.count === 'number' ? num(vars.count) : String(vars[name]);
  });
}

module.exports = { SUPPORTED, resolveLanguage, setLanguage, currentLanguage, t, num, gb, compareText, formatDate };
