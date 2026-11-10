import { num, t } from './i18n.js';
import { ICONS } from './icons.js';

/**
 * Crée un élément DOM. Les textes passent toujours par des nœuds texte (jamais d'innerHTML),
 * sauf la propriété `svg`, réservée aux icônes statiques de icons.js.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') el.style.cssText = value;
    else if (key === 'svg') el.innerHTML = value;
    else if (key === 'value') el.value = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function icon(name, size) {
  return h('span', {
    class: 'icon',
    'aria-hidden': 'true',
    style: size ? `width:${size}px;height:${size}px` : null,
    svg: ICONS[name],
  });
}

export function blockIcon(kind, extraClass = '', badge = null) {
  return h(
    'span',
    { class: `block block--${kind} ${extraClass}`.trim(), 'aria-hidden': 'true' },
    badge && h('span', { class: `block__badge block__badge--${badge}` }),
  );
}

const AVATARS = {
  a: ['HHHHHHHH', 'HHHHHHHH', 'GHSSSSHG', 'GSSSSSSG', 'SWPSSPWS', 'SSSSSSSS', 'SSSMMSSS', 'SSSSSSSS'],
  b: ['OOOOOOOO', 'OOOOOOOO', 'OOSSSSOO', 'OSSSSSSO', 'OSESSESO', 'OSSSSSSO', 'OSSmmSSO', 'OOSSSSOO'],
};
const AVATAR_COLORS = {
  H: '#1b1b22', G: '#7c5cff', S: '#e0ac85', W: '#f5f5f5', P: '#2b3a67', M: '#9c5b4a',
  O: '#5b6475', E: '#1f2937', m: '#a0644f',
};

/** Avatar pixel en attendant les vraies têtes de skin (étape 4). `make` : h de dom.js ou de ui.js. */
export function avatar(variant, size, make = h) {
  const cells = AVATARS[variant === 'b' ? 'b' : 'a'].join('').split('');
  return make(
    'span',
    { class: 'avatar', 'aria-hidden': 'true', style: `width:${size}px;height:${size}px` },
    cells.map((c) => make('span', { style: `background:${AVATAR_COLORS[c]}` })),
  );
}

export function formatPlaytime(minutes) {
  if (!minutes) return t('time.never_played');
  const h_ = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h_ ? t('dom.min', { h_, m: String(m).padStart(2, '0') }) : `${m} min`;
}

/** Durée compacte des tuiles et du bilan : « 25 h 30 », ou « 12 min » sous une heure. */
export function formatShortTime(minutes) {
  if (!minutes) return t('dom.min_2');
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  return hours ? `${hours} h ${String(total % 60).padStart(2, '0')}` : `${total} min`;
}

export function formatGo(value) {
  return `${num(Number(value))} ${t('unit.gb')}`;
}

export function slugify(name) {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'instance'
  );
}

/** « 96 Ko », « 412 Mo », « 1,6 Go » en français. */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['unit.b', 'unit.kb', 'unit.mb', 'unit.gb', 'unit.tb'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit >= 3 || (value < 10 && unit > 0) ? 1 : 0;
  return `${num(Number(value.toFixed(digits)), { maximumFractionDigits: digits })} ${t(units[unit])}`;
}
