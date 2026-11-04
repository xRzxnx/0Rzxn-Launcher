// Couleur d'accent : le violet d'origine, six autres thèmes ou une couleur perso.
// Les teintes sont calculées en OKLCH à luminosité imposée, puis vérifiées : le texte blanc
// sur l'accent et le texte d'accent sur les panneaux gardent un contraste d'au moins 4,5:1.
export const ACCENTS = [
  { id: 'violet', label: 'Violet' },
  { id: 'bleu', label: 'Bleu', hue: 255, chroma: 0.17 },
  { id: 'cyan', label: 'Cyan', hue: 215, chroma: 0.12 },
  { id: 'vert', label: 'Vert', hue: 150, chroma: 0.15 },
  { id: 'ambre', label: 'Ambre', hue: 60, chroma: 0.15 },
  { id: 'rouge', label: 'Rouge', hue: 25, chroma: 0.19 },
  { id: 'rose', label: 'Rose', hue: 350, chroma: 0.19 },
];

// Valeurs de base.css, gardées telles quelles pour le violet.
const VIOLET = {
  '--accent': '#6246ea',
  '--accent-2': '#7c5cff',
  '--accent-3': '#9d86ff',
  '--accent-text': '#b9a8ff',
  '--accent-bg': '#1c1745',
  '--accent-line': '#4a3bb0',
};
const PANEL = '#12152a';

const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function hexToRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}

/** sRGB → OKLCH (Björn Ottosson). */
export function hexToOklch(hex) {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

function oklchToRgb(l, c, h) {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

/** Couleur OKLCH en hexadécimal ; la saturation baisse jusqu'à entrer dans l'espace sRGB. */
function oklchHex(l, c, h) {
  let chroma = c;
  let rgb = oklchToRgb(l, chroma, h);
  while (chroma > 0 && rgb.some((v) => v < -0.0001 || v > 1.0001)) {
    chroma = Math.max(0, chroma - 0.004);
    rgb = oklchToRgb(l, chroma, h);
  }
  return `#${rgb.map((v) => Math.round(toGamma(Math.min(1, Math.max(0, v))) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Les six variables CSS de l'accent pour une teinte et une saturation. */
function tokensFor(hue, chroma) {
  let l = 0.52;
  let accent = oklchHex(l, chroma, hue);
  while (contrast(accent, '#ffffff') < 4.6 && l > 0.3) accent = oklchHex((l -= 0.01), chroma, hue);
  let lt = 0.8;
  let text = oklchHex(lt, chroma * 0.55, hue);
  while (contrast(text, PANEL) < 4.6 && lt < 0.95) text = oklchHex((lt += 0.01), chroma * 0.55, hue);
  return {
    '--accent': accent,
    '--accent-2': oklchHex(l + 0.08, chroma, hue),
    '--accent-3': oklchHex(l + 0.18, chroma * 0.9, hue),
    '--accent-text': text,
    '--accent-bg': oklchHex(0.24, chroma * 0.35, hue),
    '--accent-line': oklchHex(0.42, chroma * 0.65, hue),
  };
}

/** `accent` : identifiant d'un thème ou « #rrggbb ». */
export function accentTokens(accent) {
  const preset = ACCENTS.find((a) => a.id === accent);
  if (preset && !preset.hue) return VIOLET;
  if (preset) return tokensFor(preset.hue, preset.chroma);
  if (/^#[0-9a-f]{6}$/i.test(accent ?? '')) {
    const { c, h } = hexToOklch(accent);
    return tokensFor(h, Math.min(c, 0.25));
  }
  return VIOLET;
}

export function applyAccent(accent) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(accentTokens(accent))) root.style.setProperty(name, value);
}
