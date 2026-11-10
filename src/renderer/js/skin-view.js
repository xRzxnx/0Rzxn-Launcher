// Dessin des skins sans image à part : des zones de la texture affichées en CSS, en gros pixels.
// La tête d'un compte, une vignette de face et le modèle 3D reposent sur les mêmes zones.
import { avatar, h } from './dom.js';

export const textureUrl = (hash) => `skin://texture/${hash}`;
export const libraryUrl = (id) => `skin://library/${id}`;

const SKIN_HEIGHT = 64;
const CAPE_HEIGHT = 32;

/** Style d'une zone (x, y, w, h) de la texture. La hauteur de la texture suit sa largeur : 64×32 ou 64×64. */
function zone(url, x, y, w, h_, scale) {
  return `width:${w * scale}px;height:${h_ * scale}px;background-image:url("${url}");background-position:${-x * scale}px ${-y * scale}px;background-size:${64 * scale}px auto;background-repeat:no-repeat;image-rendering:pixelated`;
}

/** Tête : la face et le calque du chapeau. L'avatar reste dessous si la texture ne se charge pas. */
/** `make` : h de dom.js (par défaut) ou de ui.js pour un écran Preact. */
export function skinHead(account, size, make = h) {
  const hash = account?.look?.skin?.hash;
  const fallback = avatar(account?.type === 'microsoft' ? 'a' : 'b', size, make);
  if (!hash) return fallback;
  const scale = size / 8;
  const url = textureUrl(hash);
  return make(
    'span',
    { class: 'skin-head', 'aria-hidden': 'true', style: `width:${size}px;height:${size}px` },
    fallback,
    make('span', { class: 'skin-head__layer', style: zone(url, 8, 8, 8, 8, scale) }),
    make('span', { class: 'skin-head__layer', style: zone(url, 40, 8, 8, 8, scale) }),
  );
}

/** Vignette de face. Une texture de 64×32 n'a pas de bras ni de jambe gauches : le jeu reprend les droits. */
export function skinFront(url, { slim = false, legacy = false }, scale = 3) {
  const arm = slim ? 3 : 4;
  const part = (x, y, w, h_, dx, dy, mirror = false) =>
    h('span', { class: 'skin-front__part', style: `${zone(url, x, y, w, h_, scale)};left:${dx * scale}px;top:${dy * scale}px${mirror ? ';transform:scaleX(-1)' : ''}` });
  const layers = [
    part(8, 8, 8, 8, 4, 0),
    part(20, 20, 8, 12, 4, 8),
    part(44, 20, arm, 12, 4 - arm, 8),
    legacy ? part(44, 20, arm, 12, 12, 8, true) : part(36, 52, arm, 12, 12, 8),
    part(4, 20, 4, 12, 4, 20),
    legacy ? part(4, 20, 4, 12, 8, 20, true) : part(20, 52, 4, 12, 8, 20),
    part(40, 8, 8, 8, 4, 0),
  ];
  if (!legacy) {
    layers.push(part(20, 36, 8, 12, 4, 8), part(44, 36, arm, 12, 4 - arm, 8), part(52, 52, arm, 12, 12, 8), part(4, 36, 4, 12, 4, 20), part(4, 52, 4, 12, 8, 20));
  }
  return h('span', { class: 'skin-front', 'aria-hidden': 'true', style: `width:${16 * scale}px;height:${32 * scale}px` }, layers);
}

/** Face extérieure d'une cape. */
export function capeFront(url, scale = 4) {
  return h('span', { class: 'skin-front', 'aria-hidden': 'true', style: `display:block;${zone(url, 1, 1, 10, 16, scale)}` });
}

// Modèle 3D : chaque partie est une boîte de 6 faces en CSS.
const UNIT = 10; // pixels d'écran pour un pixel de skin

function boxFaces(out, { url, u, v, w, h: height, d, x, y, z, grow = 0, texHeight = SKIN_HEIGHT, inverted = false, mirror = false, opaque = false }) {
  const front = [u + d, v + d, w, height];
  const back = [u + 2 * d + w, v + d, w, height];
  const right = [u, v + d, d, height];
  const left = [u + d + w, v + d, d, height];
  const faces = [
    { rot: '', dist: d / 2, t: inverted ? back : front },
    { rot: 'rotateY(180deg)', dist: d / 2, t: inverted ? front : back },
    { rot: 'rotateY(-90deg)', dist: w / 2, t: mirror ? left : right },
    { rot: 'rotateY(90deg)', dist: w / 2, t: mirror ? right : left },
    { rot: 'rotateX(90deg)', dist: height / 2, t: [u + d, v, w, d] },
    { rot: 'rotateX(-90deg)', dist: height / 2, t: [u + d + w, v, w, d] },
  ];
  for (const { rot, dist, t } of faces) {
    const W = t[2] * UNIT;
    const H = t[3] * UNIT;
    const kx = ((t[2] + 2 * grow) / t[2]) * (mirror ? -1 : 1);
    const ky = (t[3] + 2 * grow) / t[3];
    out.push(
      h('span', {
        class: 'skin-model__face',
        style: `width:${W}px;height:${H}px;margin:${-H / 2}px 0 0 ${-W / 2}px;transform:translate3d(${x * UNIT}px,${y * UNIT}px,${z * UNIT}px) ${rot} translateZ(${(dist + grow) * UNIT}px) scale(${kx},${ky});background-image:url("${url}");background-position:${-t[0] * UNIT}px ${-t[1] * UNIT}px;background-size:${64 * UNIT}px ${texHeight * UNIT}px;background-repeat:no-repeat;image-rendering:pixelated${opaque ? ';background-color:#000' : ''}`,
      }),
    );
  }
}

function modelFaces({ url, slim, legacy, capeUrl }) {
  const out = [];
  const arm = slim ? 3 : 4;
  const armX = slim ? 5.5 : 6;
  const texHeight = legacy ? 32 : SKIN_HEIGHT;
  const parts = [
    { u: 0, v: 0, w: 8, h: 8, d: 8, x: 0, y: -12, ou: 32, ov: 0, grow: 0.5 },
    { u: 16, v: 16, w: 8, h: 12, d: 4, x: 0, y: -2, ou: 16, ov: 32, grow: 0.25 },
    { u: 40, v: 16, w: arm, h: 12, d: 4, x: -armX, y: -2, ou: 40, ov: 32, grow: 0.25 },
    { u: 32, v: 48, w: arm, h: 12, d: 4, x: armX, y: -2, ou: 48, ov: 48, grow: 0.25, mirrorOf: { u: 40, v: 16 } },
    { u: 0, v: 16, w: 4, h: 12, d: 4, x: -2, y: 10, ou: 0, ov: 32, grow: 0.25 },
    { u: 16, v: 48, w: 4, h: 12, d: 4, x: 2, y: 10, ou: 0, ov: 48, grow: 0.25, mirrorOf: { u: 0, v: 16 } },
  ];
  parts.forEach((p, index) => {
    const mirror = legacy && Boolean(p.mirrorOf);
    const u = mirror ? p.mirrorOf.u : p.u;
    const v = mirror ? p.mirrorOf.v : p.v;
    boxFaces(out, { url, u, v, w: p.w, h: p.h, d: p.d, x: p.x, y: p.y, z: 0, texHeight, mirror, opaque: true }); // le jeu force la couche de base en opaque
    if (!legacy || index === 0) boxFaces(out, { url, u: p.ou, v: p.ov, w: p.w, h: p.h, d: p.d, x: p.x, y: p.y, z: 0, grow: p.grow, texHeight });
  });
  if (capeUrl) boxFaces(out, { url: capeUrl, u: 0, v: 0, w: 10, h: 16, d: 1, x: 0, y: 0, z: -3, texHeight: CAPE_HEIGHT, inverted: true });
  return out;
}

/** Modèle 3D qu'on fait tourner à la souris. `view` ({ yaw, pitch }) survit aux redessins de la fenêtre. */
export function skinModel(options, view) {
  const root = h('div', { class: 'skin-model__root', style: `transform:rotateX(${view.pitch}deg) rotateY(${view.yaw}deg)` }, modelFaces(options));
  let drag = null;
  const stage = h(
    'div',
    {
      class: 'skin-model',
      onPointerdown: (e) => {
        drag = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch };
        stage.setPointerCapture(e.pointerId);
      },
      onPointermove: (e) => {
        if (!drag) return;
        view.yaw = drag.yaw + (e.clientX - drag.x) * 0.6;
        view.pitch = Math.max(-30, Math.min(30, drag.pitch - (e.clientY - drag.y) * 0.3));
        root.style.transform = `rotateX(${view.pitch}deg) rotateY(${view.yaw}deg)`;
      },
      onPointerup: () => { drag = null; },
      onPointercancel: () => { drag = null; },
    },
    root,
  );
  return stage;
}
