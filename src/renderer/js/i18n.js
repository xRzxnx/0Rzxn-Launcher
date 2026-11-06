// Traduction de l'interface : dictionnaires dans locales/, formats de nombres et de dates de la langue active.
// La langue est choisie par le processus principal (voir src/main/i18n/index.js) ; seule celle-ci est chargée.
const start = window.launcher?.language ?? { lang: 'fr', locale: 'fr-FR' };

let lang = start.lang;
let locale = start.locale;
let dict = (await import(`./locales/${lang}.js`)).default;
let rules = new Intl.PluralRules(locale);
let formats = new Map();

export const currentLanguage = () => lang;

/** Change de langue sans recharger la page : au prochain rendu, tous les textes suivent. */
export async function setLanguage(next) {
  dict = (await import(`./locales/${next.lang}.js`)).default;
  lang = next.lang;
  locale = next.locale;
  rules = new Intl.PluralRules(locale);
  formats = new Map();
  document.documentElement.lang = lang;
}

/** Formateur Intl mis en cache : les créer coûte cher, et le rendu en demande à chaque image. */
function format(Type, options) {
  const id = `${Type.name}:${JSON.stringify(options)}`;
  if (!formats.has(id)) formats.set(id, new Type(locale, options));
  return formats.get(id);
}

export const num = (value, options = {}) => format(Intl.NumberFormat, options).format(value);
export const compactNum = (value) => num(value, { notation: 'compact', maximumFractionDigits: 1 });
export const formatDateTime = (date, options) => format(Intl.DateTimeFormat, options).format(date);
export const compareText = (a, b, options = {}) => format(Intl.Collator, options).compare(a, b);

/**
 * Texte de la clé `key`. Les variables s'écrivent {nom} ; une entrée { one, other } est un pluriel,
 * choisi selon vars.count, qui s'affiche au format de la langue (12 345, 12,345…).
 */
export function t(key, vars) {
  let text = dict[key];
  if (text === undefined) return key;
  if (typeof text === 'object') text = text[rules.select(vars.count)] ?? text.other;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => {
    if (!(name in vars)) return match;
    return name === 'count' && typeof vars.count === 'number' ? num(vars.count) : String(vars[name]);
  });
}

document.documentElement.lang = lang;
