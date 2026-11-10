// Même forme que dom.js — h(balise, props, ...enfants) — mais les écrans migrés créent des éléments Preact :
// à chaque changement d'état, Preact ne touche que ce qui a changé au lieu de tout reconstruire.
// Migrer un écran = importer h, icon… depuis ui.js au lieu de dom.js. Un écran Preact ne contient jamais
// d'élément créé par dom.js (et inversement).
import { Fragment, h as createElement, render } from '../vendor/preact.js';
import { ICONS } from './icons.js';

export { formatGo, formatPlaytime, formatShortTime, formatSize, slugify } from './dom.js';

/**
 * Traduit les propriétés de dom.js pour Preact :
 * - `svg` (icônes statiques de icons.js) → dangerouslySetInnerHTML, seul HTML autorisé, comme dans dom.js ;
 * - `onClick`, `onKeyDown`… → nom d'événement en minuscules, comme addEventListener dans dom.js ;
 * - null et false → propriété absente ; `key` → clé Preact (identité d'un élément dans une liste).
 */
export function h(tag, props, ...children) {
  const p = {};
  for (const [name, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (name === 'svg') p.dangerouslySetInnerHTML = { __html: value };
    else if (name.startsWith('on') && typeof value === 'function') p[`on${name.slice(2).toLowerCase()}`] = value;
    // true : propriété DOM (disabled, checked…) ; attribut aria-/data- vide, comme setAttribute(nom, '') dans dom.js.
    else p[name] = value === true && name.includes('-') ? '' : value;
  }
  for (const child of children.flat(Infinity)) {
    if (typeof Node !== 'undefined' && child instanceof Node) throw new Error(`ui.js: <${tag}> received a DOM element from dom.js`);
  }
  return createElement(tag, p, ...children.flat(Infinity).filter((child) => child != null && child !== false && child !== true));
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

const mounted = new WeakSet();

/** Affiche un ou plusieurs éléments Preact dans `container` (Preact compare avec l'affichage précédent). */
export function mount(container, content) {
  if (!mounted.has(container)) {
    container.replaceChildren();
    mounted.add(container);
  }
  render(Array.isArray(content) ? createElement(Fragment, null, ...content) : content, container);
}

/** Avant de rendre la main à dom.js dans `container` : Preact oublie ce qu'il y avait dessiné. */
export function unmount(container) {
  if (!mounted.has(container)) return;
  render(null, container);
  mounted.delete(container);
}
