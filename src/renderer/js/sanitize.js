// Transforme le HTML des notes de version de Mojang en éléments sûrs : seule une liste
// de balises est recréée, sans aucun attribut copié tel quel (pas de script, style ni événement).
const ALLOWED = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'code', 'pre', 'blockquote', 'br', 'a', 'img']);
const IMAGE_ORIGIN = 'https://launchercontent.mojang.com';

function safeUrl(value, base) {
  try {
    const url = new URL(value, base);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function convert(node, out) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.append(document.createTextNode(child.textContent));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'iframe') continue;
    if (!ALLOWED.has(tag)) {
      convert(child, out);
      continue;
    }
    if (tag === 'img') {
      const url = safeUrl(child.getAttribute('src') ?? '', IMAGE_ORIGIN);
      if (url && url.origin === IMAGE_ORIGIN) {
        const img = document.createElement('img');
        img.src = url.href;
        img.alt = child.getAttribute('alt') ?? '';
        img.loading = 'lazy';
        out.append(img);
      }
      continue;
    }
    const el = document.createElement(tag);
    if (tag === 'a') {
      const url = safeUrl(child.getAttribute('href') ?? '', 'https://www.minecraft.net');
      if (url) {
        el.href = url.href;
        el.target = '_blank';
        el.rel = 'noopener noreferrer';
      }
    }
    convert(child, el);
    out.append(el);
  }
}

export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const fragment = document.createDocumentFragment();
  convert(doc.body, fragment);
  return fragment;
}
