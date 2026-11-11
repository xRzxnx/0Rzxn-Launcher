// @ts-check
'use strict';

// Page affichée dans le navigateur à la fin d'une connexion Microsoft (phase 7).
// Servie par le launcher lui-même sur l'adresse locale : aucun script, aucune ressource externe.
const { t, currentLanguage } = require('../i18n');

/** @param {unknown} value */
const escape = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

// Logo du launcher (même tracé que l'icône de l'application).
const LOGO =
  '<svg width="17" height="17" viewBox="0 0 256 256" aria-hidden="true"><path fill="#fff" fill-rule="evenodd" d="M68 34H182L218 70V98L182 134H169L225 190H180L140 150V190H68L32 154V70ZM140 66V102H172L186 88V80L172 66ZM108 66H81L64 83V141L81 158H108Z"/></svg>';
const ICON_OK = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
const ICON_KO = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';
const ICON_WAIT = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

const STYLE = `
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;color:#fff;
background:radial-gradient(1000px 600px at 30% 10%,#3b2a74 0%,rgba(59,42,116,0) 60%),radial-gradient(900px 600px at 80% 90%,#25407a 0%,rgba(37,64,122,0) 60%),#140c22}
main{width:min(540px,100%);border-radius:24px;background:rgba(30,22,58,.7);border:1px solid rgba(255,255,255,.18);box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 24px 60px rgba(8,5,20,.5);padding:34px 36px;display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:15px;color:#ebeaf6}
.logo{width:28px;height:28px;border-radius:8px;background:#6d4ff0;display:flex;align-items:center;justify-content:center}
.mark{width:64px;height:64px;border-radius:20px;display:flex;align-items:center;justify-content:center;margin-top:6px}
.ok .mark{background:rgba(61,220,132,.2);color:#8df0b6}
.ko .mark{background:rgba(255,120,120,.2);color:#ffb3b3}
.wait .mark{background:rgba(168,146,255,.2);color:#d6cbff}
h1{margin:0;font-size:30px;line-height:36px;font-weight:700;letter-spacing:-.01em}
p{margin:0;font-size:15px;line-height:22px;color:#ebeaf6;max-width:440px}
.who{font-size:16px}.who b{color:#fff}
.next{font-size:14px;line-height:20px;color:#fff;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:10px 14px}
.small{font-size:12.5px;line-height:18px;color:#c9c8dc}
.code{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#c9c8dc}
`;

/** Politique de sécurité de la page (aussi envoyée en en-tête par core/loopback.js). */
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Textes d'une erreur selon son code ; les autres codes affichent le message de l'erreur. */
function errorTexts(code, message) {
  if (code === 'DENIED') {
    return { title: t('login_page.connexion_refusee'), text: t('login_page.tu_as_refuse_acces'), next: t('login_page.ferme_cet_onglet_tu_peux') };
  }
  if (code === 'NOT_OWNED') {
    return { title: t('login_page.ce_compte_ne_possede_pas'), text: t('login_page.la_connexion_microsoft_a_reussi'), next: t('login_page.ferme_cet_onglet_et_reconnecte') };
  }
  if (code === 'STATE') {
    return { title: t('login_page.reponse_de_connexion_inattendue'), text: t('login_page.cette_reponse_ne_correspond_pas'), next: t('login_page.ferme_cet_onglet_et_relance') };
  }
  return { title: t('login_page.connexion_impossible'), text: message, next: t('login_page.ferme_cet_onglet_et_reessaie') };
}

/**
 * Page HTML complète.
 * @param {{ kind: 'ok', name: string } | { kind: 'error', code?: string, message?: string } | { kind: 'pending' }} outcome
 */
function loginPage(outcome) {
  let tone;
  let icon;
  let body;
  let title;
  if (outcome.kind === 'ok') {
    tone = 'ok';
    icon = ICON_OK;
    title = t('login_page.connexion_reussie');
    // Le pseudo est mis en gras : la phrase traduite est échappée, puis le marqueur remplacé.
    const who = escape(t('login_page.connecte_en_tant_que', { name: '\u0000' })).replace('\u0000', `<b>${escape(outcome.name)}</b>`);
    body = `<p class="who">${who}</p><p>${escape(t('login_page.tu_peux_fermer_cet_onglet'))}</p><p class="small">${escape(t('login_page.le_launcher_ne_voit_jamais'))}</p>`;
  } else if (outcome.kind === 'pending') {
    tone = 'wait';
    icon = ICON_WAIT;
    title = t('login_page.retourne_au_launcher');
    body = `<p>${escape(t('login_page.la_connexion_continue_dans_le'))}</p><p class="next">${escape(t('login_page.tu_peux_fermer_cet_onglet_court'))}</p>`;
  } else {
    tone = 'ko';
    icon = ICON_KO;
    const texts = errorTexts(outcome.code, outcome.message ?? '');
    title = texts.title;
    body = `<p>${escape(texts.text)}</p><p class="next">${escape(texts.next)}</p>${outcome.code ? `<p class="code">${escape(outcome.code)}</p>` : ''}`;
  }
  return `<!doctype html>
<html lang="${escape(currentLanguage())}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">
<meta name="referrer" content="no-referrer">
<title>${escape(title)} · 0Rzxn_ Launcher</title>
<style>${STYLE}</style>
</head>
<body>
<main class="${tone}" aria-labelledby="title">
<span class="brand"><span class="logo">${LOGO}</span>0Rzxn_ Launcher</span>
<span class="mark">${icon}</span>
<h1 id="title">${escape(title)}</h1>
${body}
</main>
</body>
</html>
`;
}

module.exports = { loginPage, PAGE_CSP, escape };
