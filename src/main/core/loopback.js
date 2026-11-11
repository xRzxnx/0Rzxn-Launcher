// @ts-check
'use strict';

// Adresse de retour locale de la connexion Microsoft dans le navigateur (phase 7, RFC 8252).
// Un petit serveur écoute sur 127.0.0.1 et ::1 (même port, choisi par le système) ; Microsoft y renvoie
// le navigateur avec le code. Seule « GET / » avec un code ou une erreur et le bon « state » est prise ;
// tout le reste reçoit 404. La réponse au navigateur attend le vrai résultat de la connexion (au plus
// 30 s), puis le serveur se ferme. Sans réponse au bout de 10 minutes, la connexion est annulée.
const http = require('node:http');
const { t } = require('../i18n');
const { MicrosoftAuthError, LOOPBACK_URI, parseParams } = require('./microsoft');
const { loginPage, PAGE_CSP } = require('./login-page');

const WAIT_MS = 10 * 60_000;
const HOLD_MS = 30_000;

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': PAGE_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  Connection: 'close',
};

/** @param {http.Server} server @param {number} port @param {string} host @returns {Promise<void>} */
function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const failed = (/** @type {Error} */ error) => reject(error);
    server.once('error', failed);
    server.listen({ port, host, exclusive: true }, () => {
      server.off('error', failed);
      resolve();
    });
  });
}

/** @param {http.Server} server */
function shut(server) {
  server.close();
  server.closeAllConnections();
}

/**
 * Ouvre l'adresse de retour. `wait` donne { code } (ou l'erreur de Microsoft) ; `respond(résultat)` écrit
 * la page du navigateur et ferme le serveur ; `close()` annule.
 * @param {{ state: string, waitMs?: number, holdMs?: number }} options
 */
async function openLoopback({ state, waitMs = WAIT_MS, holdMs = HOLD_MS }) {
  /** @type {http.Server[]} */
  let servers = [];
  let port = 0;
  /** @type {http.ServerResponse | null} */
  let held = null;
  let received = false;
  let closed = false;
  /** @type {NodeJS.Timeout | undefined} */
  let holdTimer;
  /** @type {NodeJS.Timeout | undefined} */
  let waitTimer;
  /** @type {(value: { code: string }) => void} */
  let resolveWait = () => {};
  /** @type {(error: Error) => void} */
  let rejectWait = () => {};
  const wait = new Promise((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  wait.catch(() => {}); // l'appelant peut ne jamais attendre (annulation avant la page)

  /** @param {http.ServerResponse} res @param {number} status @param {Parameters<typeof loginPage>[0]} outcome @param {() => void} [after] */
  const sendPage = (res, status, outcome, after) => {
    res.writeHead(status, PAGE_HEADERS);
    res.end(loginPage(outcome), after);
  };
  const notFound = (/** @type {http.ServerResponse} */ res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
    res.end('Not found');
  };

  const stop = () => {
    if (closed) return;
    closed = true;
    clearTimeout(waitTimer);
    clearTimeout(holdTimer);
    for (const server of servers) shut(server);
  };

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  const onRequest = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const host = String(req.headers.host ?? '').toLowerCase();
    const hostOk = host === `localhost:${port}` || host === `127.0.0.1:${port}` || host === `[::1]:${port}`;
    const params = url.searchParams;
    if (closed || req.method !== 'GET' || url.pathname !== '/' || !hostOk || (!params.has('code') && !params.has('error'))) {
      notFound(res);
      return;
    }
    // Réponse d'une autre connexion (vieil onglet) : refusée, on continue d'attendre la bonne.
    if (params.get('state') !== state) {
      sendPage(res, 400, { kind: 'error', code: 'STATE' });
      return;
    }
    // Onglet rechargé après le retour : le résultat arrive dans le launcher.
    if (received) {
      sendPage(res, 200, { kind: 'pending' });
      return;
    }
    received = true;
    held = res;
    clearTimeout(waitTimer);
    holdTimer = setTimeout(() => {
      const late = held;
      held = null;
      if (late) sendPage(late, 200, { kind: 'pending' });
    }, holdMs);
    try {
      resolveWait(parseParams(params, state));
    } catch (error) {
      rejectWait(/** @type {Error} */ (error));
    }
  };

  // 127.0.0.1 d'abord sur un port libre, puis ::1 sur le même port (le navigateur peut choisir l'un ou l'autre
  // pour « localhost »). Sans IPv6, l'IPv4 suffit ; si le port est pris en IPv6, on recommence.
  for (let attempt = 0; attempt < 5 && !servers.length; attempt++) {
    const v4 = http.createServer(onRequest);
    await listen(v4, 0, '127.0.0.1');
    const address = v4.address();
    port = typeof address === 'object' && address ? address.port : 0;
    const v6 = http.createServer(onRequest);
    try {
      await listen(v6, port, '::1');
      servers = [v4, v6];
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code === 'EADDRINUSE') {
        shut(v4);
        continue;
      }
      servers = [v4];
    }
  }
  if (!servers.length) throw new MicrosoftAuthError(t('microsoft.adresse_locale_indisponible'), 'LOOPBACK');

  waitTimer = setTimeout(() => {
    rejectWait(new MicrosoftAuthError(t('microsoft.aucune_reponse_du_navigateur'), 'TIMEOUT'));
    stop();
  }, waitMs);

  return {
    port,
    redirectUri: `${LOOPBACK_URI}:${port}`,
    /** @type {Promise<{ code: string }>} */
    wait,
    /**
     * Écrit la page de fin dans le navigateur (si elle attend encore) et ferme le serveur.
     * @param {Parameters<typeof loginPage>[0]} outcome
     */
    respond(outcome) {
      const res = held;
      held = null;
      clearTimeout(holdTimer);
      if (res) sendPage(res, 200, outcome, stop);
      else stop();
    },
    /** Annule : la connexion en attente échoue (CANCELLED) et le serveur se ferme. */
    close() {
      rejectWait(new MicrosoftAuthError(t('microsoft.connexion_annulee'), 'CANCELLED'));
      const res = held;
      held = null;
      if (res) sendPage(res, 200, { kind: 'pending' }, stop);
      else stop();
    },
  };
}

module.exports = { openLoopback, WAIT_MS, HOLD_MS };
