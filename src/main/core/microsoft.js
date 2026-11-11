'use strict';

// Connexion Microsoft → Xbox Live → XSTS → Minecraft (méthode officielle avec une application Azure).
// Référence : https://minecraft.wiki/w/Microsoft_authentication
const { t } = require('../i18n');
const crypto = require('node:crypto');

const OAUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const REDIRECT_URI = 'https://login.microsoftonline.com/common/oauth2/nativeclient';
// Connexion dans le navigateur (phase 7) : adresse locale, dont Microsoft ignore le port (inscrite « http://localhost » dans Azure).
const LOOPBACK_URI = 'http://localhost';
/** Adresse de retour à utiliser pour un compte : « loopback » (navigateur) ou, par défaut, la fenêtre intégrée. */
const redirectFor = (redirect) => (redirect === 'loopback' ? LOOPBACK_URI : REDIRECT_URI);
const SCOPE = 'XboxLive.signin offline_access';
const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
// LAUNCHER_MC_API pointe le launcher vers un faux serveur pour les tests.
const MC = (process.env.LAUNCHER_MC_API ?? '').trim() || 'https://api.minecraftservices.com';
const TIMEOUT_MS = 20_000;

const XSTS_ERRORS = {
  get 2148916227() { return t('microsoft.ce_compte_est_banni_du'); },
  get 2148916233() { return t('microsoft.ce_compte_microsoft_pas_encore'); },
  get 2148916235() { return t('microsoft.le_xbox_live_est_pas'); },
  get 2148916236() { return t('microsoft.une_verification_de_age_est'); },
  get 2148916237() { return t('microsoft.une_verification_de_age_est'); },
  get 2148916238() { return t('microsoft.est_un_compte_enfant_un'); },
};

class MicrosoftAuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MicrosoftAuthError';
    this.code = code;
  }
}

async function call(url, { method = 'GET', headers = {}, json, form, multipart, token } = {}) {
  const init = { method, headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (json) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  if (form) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(form).toString();
  }
  if (multipart) init.body = multipart; // fetch écrit lui-même le Content-Type
  let res;
  try {
    res = await fetch(url, init);
  } catch (error) {
    throw new MicrosoftAuthError(t('microsoft.pas_de_reponse_de', { host: new URL(url).host, code: error.cause?.code ?? error.message }), 'NETWORK');
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, ok: res.ok, body, text, retryAfter: Number(res.headers.get('retry-after')) || 0 };
}

// ---------- 1. OAuth Microsoft (code d'autorisation + PKCE) ----------

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Valeur « state » d'une connexion : relie la réponse de Microsoft à la connexion lancée. */
const newState = () => base64url(crypto.randomBytes(16));

/**
 * Prépare l'adresse de la page de connexion Microsoft.
 * @param {string} clientId
 * @param {{ redirectUri?: string, state?: string }} [options] adresse de retour : fenêtre intégrée (par défaut) ou
 *   http://localhost:<port> ; `state` déjà choisi (l'adresse locale l'attend avant que la page soit prête).
 */
function createAuthorization(clientId, { redirectUri = REDIRECT_URI, state = newState() } = {}) {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const url = new URL(`${OAUTH}/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return { url: url.href, verifier, state };
}

/**
 * Analyse l'adresse de retour. Renvoie null si ce n'est pas l'adresse de retour,
 * sinon { code } ou lève une erreur (connexion refusée, état incohérent…).
 */
function parseRedirect(rawUrl, expectedState) {
  if (!rawUrl.startsWith(REDIRECT_URI)) return null;
  return parseParams(new URL(rawUrl).searchParams, expectedState);
}

/**
 * Paramètres de retour (fenêtre intégrée ou adresse locale) : { code }, ou une erreur
 * DENIED (refus), STATE (autre connexion), NO_CODE, ou le code d'erreur de Microsoft.
 * @param {URLSearchParams} params
 * @param {string} expectedState
 */
function parseParams(params, expectedState) {
  if (params.get('error')) {
    const description = params.get('error_description') ?? params.get('error');
    if (params.get('error') === 'access_denied') throw new MicrosoftAuthError(t('microsoft.connexion_refusee'), 'DENIED');
    throw new MicrosoftAuthError(t('microsoft.microsoft_refuse_la_connexion', { description }), params.get('error'));
  }
  if (params.get('state') !== expectedState) throw new MicrosoftAuthError(t('microsoft.reponse_de_connexion_inattendue_reessaie'), 'STATE');
  const code = params.get('code');
  if (!code) throw new MicrosoftAuthError(t('microsoft.reponse_de_connexion_incomplete_reessaie'), 'NO_CODE');
  return { code };
}

function tokenError(res) {
  const error = res.body?.error;
  if (error === 'invalid_grant') return new MicrosoftAuthError(t('microsoft.la_session_microsoft_expire_reconnecte'), 'EXPIRED');
  if (error === 'invalid_client' || error === 'unauthorized_client') {
    return new MicrosoftAuthError(t('microsoft.application_azure_du_launcher_est'), error);
  }
  return new MicrosoftAuthError(t('microsoft.microsoft_refuse_le_jeton', { error_description: res.body?.error_description ?? res.status }), error ?? 'TOKEN');
}

async function redeemCode(clientId, code, verifier, redirectUri = REDIRECT_URI) {
  const res = await call(`${OAUTH}/token`, {
    method: 'POST',
    form: { client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, scope: SCOPE },
  });
  if (!res.ok || !res.body?.access_token) throw tokenError(res);
  return { accessToken: res.body.access_token, refreshToken: res.body.refresh_token };
}

async function refreshMicrosoft(clientId, refreshToken, redirectUri = REDIRECT_URI) {
  const res = await call(`${OAUTH}/token`, {
    method: 'POST',
    form: { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken, redirect_uri: redirectUri, scope: SCOPE },
  });
  if (!res.ok || !res.body?.access_token) throw tokenError(res);
  return { accessToken: res.body.access_token, refreshToken: res.body.refresh_token ?? refreshToken };
}

// ---------- 2. Xbox Live, XSTS, Minecraft ----------

async function xboxLive(msAccessToken) {
  const res = await call(XBL_URL, {
    method: 'POST',
    json: {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    },
  });
  if (!res.ok || !res.body?.Token) throw new MicrosoftAuthError(t('microsoft.connexion_xbox_live_refusee', { status: res.status }), 'XBL');
  return { token: res.body.Token, userHash: res.body.DisplayClaims?.xui?.[0]?.uhs };
}

async function xsts(xblToken) {
  const res = await call(XSTS_URL, {
    method: 'POST',
    json: { Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' },
  });
  if (res.status === 401) {
    const xerr = res.body?.XErr;
    throw new MicrosoftAuthError(XSTS_ERRORS[xerr] ?? t('microsoft.acces_xbox_refuse_code', { xerr: xerr ?? 401 }), `XSTS_${xerr ?? 401}`);
  }
  if (!res.ok || !res.body?.Token) throw new MicrosoftAuthError(t('microsoft.autorisation_xbox_refusee', { status: res.status }), 'XSTS');
  const claims = res.body.DisplayClaims?.xui?.[0] ?? {};
  return { token: res.body.Token, userHash: claims.uhs, xuid: claims.xid };
}

async function minecraftLogin(userHash, xstsToken) {
  const res = await call(`${MC}/authentication/login_with_xbox`, {
    method: 'POST',
    json: { identityToken: `XBL3.0 x=${userHash};${xstsToken}` },
  });
  if (res.status === 403) {
    throw new MicrosoftAuthError(
      t('microsoft.mojang_pas_encore_approuve_application'),
      'APP_NOT_APPROVED',
    );
  }
  if (res.status === 429) throw new MicrosoftAuthError(t('microsoft.trop_de_connexions_en_peu'), 'RATE_LIMIT');
  if (!res.ok || !res.body?.access_token) throw new MicrosoftAuthError(t('microsoft.connexion_minecraft_refusee', { status: res.status }), 'MC_LOGIN');
  return { accessToken: res.body.access_token, expiresAt: Date.now() + (res.body.expires_in ?? 86400) * 1000 };
}

async function profile(mcAccessToken) {
  const res = await call(`${MC}/minecraft/profile`, { token: mcAccessToken });
  if (res.status === 404) {
    throw new MicrosoftAuthError(
      t('microsoft.ce_compte_ne_possede_pas'),
      'NOT_OWNED',
    );
  }
  if (!res.ok || !res.body?.id) throw new MicrosoftAuthError(t('microsoft.profil_minecraft_introuvable', { status: res.status }), 'PROFILE');
  const skin = res.body.skins?.find((s) => s.state === 'ACTIVE') ?? res.body.skins?.[0];
  return { uuid: res.body.id, name: res.body.name, skinUrl: skin?.url ?? null };
}

// ---------- 3. Skins et capes (avec un jeton Minecraft) ----------

/** Toutes ces routes renvoient le profil complet : skins, capes et leur état. */
async function profileCall(path, what, options = {}) {
  const res = await call(`${MC}${path}`, options);
  if (res.status === 401) throw new MicrosoftAuthError(t('microsoft.la_session_minecraft_expire'), 'UNAUTHORIZED');
  if (res.status === 429) {
    const error = new MicrosoftAuthError(t('microsoft.mojang_limite_les_changements_de'), 'RATE_LIMIT');
    error.retryAfter = res.retryAfter;
    throw error;
  }
  if (res.status === 403) throw new MicrosoftAuthError(t('microsoft.mojang_refuse_de_compte_suspendu', { what }), 'FORBIDDEN');
  if (res.status === 404) throw new MicrosoftAuthError(t('microsoft.ce_compte_pas_de_profil'), 'NOT_OWNED');
  if (!res.ok) {
    const reason = res.body?.errorMessage ?? res.body?.details?.status ?? res.status;
    throw new MicrosoftAuthError(t('microsoft.mojang_refuse_de', { what, reason }), 'SKIN_REJECTED');
  }
  return res.body;
}

const fullProfile = (token) => profileCall('/minecraft/profile', t('microsoft.lire_le_profil'), { token });

function uploadSkin(token, { png, variant }) {
  const form = new FormData();
  form.set('variant', variant);
  form.set('file', new Blob([png], { type: 'image/png' }), 'skin.png');
  return profileCall('/minecraft/profile/skins', t('microsoft.changer_le_skin'), { method: 'POST', multipart: form, token });
}

const resetSkin = (token) => profileCall('/minecraft/profile/skins/active', t('microsoft.remettre_le_skin_par_defaut'), { method: 'DELETE', token });
const showCape = (token, capeId) => profileCall('/minecraft/profile/capes/active', t('microsoft.changer_la_cape'), { method: 'PUT', json: { capeId }, token });
const hideCape = (token) => profileCall('/minecraft/profile/capes/active', t('microsoft.masquer_la_cape'), { method: 'DELETE', token });

/** De jetons Microsoft jusqu'au profil Minecraft. `redirect` est gardé avec le compte pour les renouvellements. */
async function minecraftFromMicrosoft(ms, redirect) {
  const xbl = await xboxLive(ms.accessToken);
  const authz = await xsts(xbl.token);
  const mc = await minecraftLogin(authz.userHash ?? xbl.userHash, authz.token);
  const player = await profile(mc.accessToken);
  return {
    ...player,
    xuid: authz.xuid ?? '0',
    refreshToken: ms.refreshToken,
    accessToken: mc.accessToken,
    expiresAt: mc.expiresAt,
    redirect,
  };
}

/**
 * Première connexion, après la page Microsoft. `redirectUri` : l'adresse de retour utilisée pour cette connexion.
 * La session renvoyée porte `redirect` : 'loopback' (navigateur) ou 'native' (fenêtre intégrée).
 */
async function signIn(clientId, code, verifier, redirectUri = REDIRECT_URI) {
  const redirect = redirectUri === LOOPBACK_URI || redirectUri.startsWith(`${LOOPBACK_URI}:`) ? 'loopback' : 'native';
  return minecraftFromMicrosoft(await redeemCode(clientId, code, verifier, redirectUri), redirect);
}

/** Renouvellement silencieux (avant un lancement), avec la même sorte d'adresse de retour que la connexion du compte. */
async function renew(clientId, refreshToken, redirect = 'native') {
  const kind = redirect === 'loopback' ? 'loopback' : 'native';
  return minecraftFromMicrosoft(await refreshMicrosoft(clientId, refreshToken, redirectFor(kind)), kind);
}

module.exports = {
  MicrosoftAuthError,
  REDIRECT_URI,
  LOOPBACK_URI,
  newState,
  createAuthorization,
  parseRedirect,
  parseParams,
  signIn,
  renew,
  fullProfile,
  uploadSkin,
  resetSkin,
  showCape,
  hideCape,
};
