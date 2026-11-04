'use strict';

// Connexion Microsoft → Xbox Live → XSTS → Minecraft (méthode officielle avec une application Azure).
// Référence : https://minecraft.wiki/w/Microsoft_authentication
const crypto = require('node:crypto');

const OAUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const REDIRECT_URI = 'https://login.microsoftonline.com/common/oauth2/nativeclient';
const SCOPE = 'XboxLive.signin offline_access';
const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
// LAUNCHER_MC_API pointe le launcher vers un faux serveur pour les tests.
const MC = (process.env.LAUNCHER_MC_API ?? '').trim() || 'https://api.minecraftservices.com';
const TIMEOUT_MS = 20_000;

const XSTS_ERRORS = {
  2148916227: 'Ce compte est banni du Xbox Live.',
  2148916233: "Ce compte Microsoft n'a pas encore de profil Xbox : crée-le sur xbox.com puis réessaie.",
  2148916235: "Le Xbox Live n'est pas disponible dans ton pays.",
  2148916236: 'Une vérification de l’âge est nécessaire sur le site Xbox (Corée du Sud).',
  2148916237: 'Une vérification de l’âge est nécessaire sur le site Xbox (Corée du Sud).',
  2148916238: "C'est un compte enfant : un adulte doit l'ajouter à une famille Microsoft avant de pouvoir jouer.",
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
    throw new MicrosoftAuthError(`Pas de réponse de ${new URL(url).host} (${error.cause?.code ?? error.message}).`, 'NETWORK');
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

/** Prépare l'adresse de la page de connexion Microsoft. */
function createAuthorization(clientId) {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));
  const url = new URL(`${OAUTH}/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
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
  const params = new URL(rawUrl).searchParams;
  if (params.get('error')) {
    const description = params.get('error_description') ?? params.get('error');
    if (params.get('error') === 'access_denied') throw new MicrosoftAuthError('Connexion refusée.', 'DENIED');
    throw new MicrosoftAuthError(`Microsoft a refusé la connexion : ${description}`, params.get('error'));
  }
  if (params.get('state') !== expectedState) throw new MicrosoftAuthError('Réponse de connexion inattendue, réessaie.', 'STATE');
  const code = params.get('code');
  if (!code) throw new MicrosoftAuthError('Réponse de connexion incomplète, réessaie.', 'NO_CODE');
  return { code };
}

function tokenError(res) {
  const error = res.body?.error;
  if (error === 'invalid_grant') return new MicrosoftAuthError('La session Microsoft a expiré : reconnecte ce compte.', 'EXPIRED');
  if (error === 'invalid_client' || error === 'unauthorized_client') {
    return new MicrosoftAuthError("L'application Azure du launcher est mal configurée (voir docs/MICROSOFT.md).", error);
  }
  return new MicrosoftAuthError(`Microsoft a refusé le jeton (${res.body?.error_description ?? res.status}).`, error ?? 'TOKEN');
}

async function redeemCode(clientId, code, verifier) {
  const res = await call(`${OAUTH}/token`, {
    method: 'POST',
    form: { client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier, scope: SCOPE },
  });
  if (!res.ok || !res.body?.access_token) throw tokenError(res);
  return { accessToken: res.body.access_token, refreshToken: res.body.refresh_token };
}

async function refreshMicrosoft(clientId, refreshToken) {
  const res = await call(`${OAUTH}/token`, {
    method: 'POST',
    form: { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken, redirect_uri: REDIRECT_URI, scope: SCOPE },
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
  if (!res.ok || !res.body?.Token) throw new MicrosoftAuthError(`Connexion Xbox Live refusée (${res.status}).`, 'XBL');
  return { token: res.body.Token, userHash: res.body.DisplayClaims?.xui?.[0]?.uhs };
}

async function xsts(xblToken) {
  const res = await call(XSTS_URL, {
    method: 'POST',
    json: { Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' },
  });
  if (res.status === 401) {
    const xerr = res.body?.XErr;
    throw new MicrosoftAuthError(XSTS_ERRORS[xerr] ?? `Accès Xbox refusé (code ${xerr ?? 401}).`, `XSTS_${xerr ?? 401}`);
  }
  if (!res.ok || !res.body?.Token) throw new MicrosoftAuthError(`Autorisation Xbox refusée (${res.status}).`, 'XSTS');
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
      "Mojang n'a pas encore approuvé l'application du launcher (Invalid app registration). Attends la réponse au formulaire, puis réessaie.",
      'APP_NOT_APPROVED',
    );
  }
  if (res.status === 429) throw new MicrosoftAuthError('Trop de connexions en peu de temps : réessaie dans quelques minutes.', 'RATE_LIMIT');
  if (!res.ok || !res.body?.access_token) throw new MicrosoftAuthError(`Connexion Minecraft refusée (${res.status}).`, 'MC_LOGIN');
  return { accessToken: res.body.access_token, expiresAt: Date.now() + (res.body.expires_in ?? 86400) * 1000 };
}

async function profile(mcAccessToken) {
  const res = await call(`${MC}/minecraft/profile`, { token: mcAccessToken });
  if (res.status === 404) {
    throw new MicrosoftAuthError(
      "Ce compte ne possède pas Minecraft: Java Edition (ou n'a pas encore choisi de pseudo : lance une fois le launcher officiel).",
      'NOT_OWNED',
    );
  }
  if (!res.ok || !res.body?.id) throw new MicrosoftAuthError(`Profil Minecraft introuvable (${res.status}).`, 'PROFILE');
  const skin = res.body.skins?.find((s) => s.state === 'ACTIVE') ?? res.body.skins?.[0];
  return { uuid: res.body.id, name: res.body.name, skinUrl: skin?.url ?? null };
}

// ---------- 3. Skins et capes (avec un jeton Minecraft) ----------

/** Toutes ces routes renvoient le profil complet : skins, capes et leur état. */
async function profileCall(path, what, options = {}) {
  const res = await call(`${MC}${path}`, options);
  if (res.status === 401) throw new MicrosoftAuthError('La session Minecraft a expiré.', 'UNAUTHORIZED');
  if (res.status === 429) {
    const error = new MicrosoftAuthError('Mojang limite les changements de skin : attends une minute avant de réessayer.', 'RATE_LIMIT');
    error.retryAfter = res.retryAfter;
    throw error;
  }
  if (res.status === 403) throw new MicrosoftAuthError(`Mojang a refusé de ${what} : compte suspendu ou session non valide.`, 'FORBIDDEN');
  if (res.status === 404) throw new MicrosoftAuthError("Ce compte n'a pas de profil Minecraft.", 'NOT_OWNED');
  if (!res.ok) {
    const reason = res.body?.errorMessage ?? res.body?.details?.status ?? res.status;
    throw new MicrosoftAuthError(`Mojang a refusé de ${what} (${reason}).`, 'SKIN_REJECTED');
  }
  return res.body;
}

const fullProfile = (token) => profileCall('/minecraft/profile', 'lire le profil', { token });

function uploadSkin(token, { png, variant }) {
  const form = new FormData();
  form.set('variant', variant);
  form.set('file', new Blob([png], { type: 'image/png' }), 'skin.png');
  return profileCall('/minecraft/profile/skins', 'changer le skin', { method: 'POST', multipart: form, token });
}

const resetSkin = (token) => profileCall('/minecraft/profile/skins/active', 'remettre le skin par défaut', { method: 'DELETE', token });
const showCape = (token, capeId) => profileCall('/minecraft/profile/capes/active', 'changer la cape', { method: 'PUT', json: { capeId }, token });
const hideCape = (token) => profileCall('/minecraft/profile/capes/active', 'masquer la cape', { method: 'DELETE', token });

/** De jetons Microsoft jusqu'au profil Minecraft. */
async function minecraftFromMicrosoft(ms) {
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
  };
}

/** Première connexion, après la page Microsoft. */
async function signIn(clientId, code, verifier) {
  return minecraftFromMicrosoft(await redeemCode(clientId, code, verifier));
}

/** Renouvellement silencieux (avant un lancement), à partir du jeton de rafraîchissement. */
async function renew(clientId, refreshToken) {
  return minecraftFromMicrosoft(await refreshMicrosoft(clientId, refreshToken));
}

module.exports = {
  MicrosoftAuthError,
  REDIRECT_URI,
  createAuthorization,
  parseRedirect,
  signIn,
  renew,
  fullProfile,
  uploadSkin,
  resetSkin,
  showCape,
  hideCape,
};
