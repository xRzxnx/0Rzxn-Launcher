'use strict';

// Comptes hors-ligne et Microsoft. Les jetons Microsoft sont chiffrés par un « coffre » fourni
// par Electron (safeStorage, lié à la session Windows) : ce module reste en Node pur.
const crypto = require('node:crypto');
const path = require('node:path');
const { readJson, writeJson } = require('./store');

const PSEUDO = /^[A-Za-z0-9_]{3,16}$/;
const RENEW_MARGIN_MS = 10 * 60 * 1000;

/** UUID hors-ligne calculé comme Minecraft : UUID v3 de « OfflinePlayer:<pseudo> ». */
function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return hash.toString('hex');
}

/** Coffre par défaut (tests) : aucun chiffrement. Electron fournit un vrai coffre (voir ipc.js). */
const PLAIN_VAULT = {
  encrypt: (text) => `plain:${Buffer.from(text, 'utf8').toString('base64')}`,
  decrypt: (data) => Buffer.from(data.replace(/^plain:/, ''), 'base64').toString('utf8'),
};

class AccountStore {
  /**
   * @param {string} configDir
   * @param {{ vault?: { encrypt(text): string, decrypt(data): string }, renew?: (refreshToken) => Promise<object> }} options
   *   renew : renouvelle une session Microsoft (core/microsoft.js renew, avec le client ID).
   */
  constructor(configDir, { vault = PLAIN_VAULT, renew = null } = {}) {
    this.file = path.join(configDir, 'accounts.json');
    this.vault = vault;
    this.renew = renew;
    this.data = readJson(this.file, { activeId: null, accounts: [] });
  }

  save() {
    writeJson(this.file, this.data);
  }

  list() {
    return {
      activeId: this.data.activeId,
      accounts: this.data.accounts.map(({ id, type, name, uuid, needsLogin, look }) => ({ id, type, name, uuid, needsLogin: Boolean(needsLogin), look: look ?? null })),
    };
  }

  all() {
    return this.data.accounts;
  }

  get(id) {
    const account = this.data.accounts.find((a) => a.id === id);
    if (!account) throw new Error('Compte introuvable.');
    return account;
  }

  /** Apparence d'un compte (skin, cape, capes possédées). Rien de secret : tout est public chez Mojang, sauf la liste des capes. */
  setLook(id, look) {
    this.get(id).look = look;
    this.save();
  }

  /** Le compte choisi pour une instance s'il existe encore, sinon le compte actif. */
  resolveId(wanted) {
    return this.data.accounts.some((a) => a.id === wanted) ? wanted : this.data.activeId;
  }

  /**
   * Un nouveau compte hors-ligne demande d'abord un compte Microsoft.
   * Un compte Microsoft n'est enregistré que si son profil Minecraft existe (sinon NOT_OWNED,
   * voir microsoft.js), donc sa présence prouve que le jeu a été acheté sur ce launcher.
   * Les comptes hors-ligne déjà créés continuent de marcher.
   */
  canAddOffline() {
    return this.data.accounts.some((a) => a.type === 'microsoft');
  }

  addOffline(rawName) {
    if (!this.canAddOffline()) {
      throw new Error("Connecte d'abord un compte Microsoft qui possède Minecraft: Java Edition. Les comptes hors-ligne se débloquent ensuite.");
    }
    const name = String(rawName ?? '').trim();
    if (!PSEUDO.test(name)) throw new Error('3 à 16 caractères : lettres, chiffres et _ uniquement.');
    if (this.data.accounts.some((a) => a.type === 'offline' && a.name.toLowerCase() === name.toLowerCase())) {
      throw new Error('Ce pseudo existe déjà.');
    }
    const uuid = offlineUuid(name);
    const account = { id: `offline-${uuid}`, type: 'offline', name, uuid };
    this.data.accounts.push(account);
    this.data.activeId = account.id;
    this.save();
    return this.list();
  }

  /**
   * Ajoute (ou reconnecte) un compte Microsoft à partir du résultat de microsoft.signIn().
   * `activate: false` : un renouvellement silencieux ne change pas le compte actif.
   */
  addMicrosoft(session, { activate = true } = {}) {
    const id = `microsoft-${session.uuid}`;
    const index = this.data.accounts.findIndex((a) => a.id === id);
    const account = {
      id,
      type: 'microsoft',
      name: session.name,
      uuid: session.uuid,
      xuid: session.xuid,
      secrets: this.vault.encrypt(
        JSON.stringify({ refreshToken: session.refreshToken, accessToken: session.accessToken, expiresAt: session.expiresAt }),
      ),
    };
    if (index >= 0) {
      if (this.data.accounts[index].look) account.look = this.data.accounts[index].look;
      this.data.accounts[index] = account;
    } else this.data.accounts.push(account);
    if (activate) this.data.activeId = id;
    this.save();
    return this.list();
  }

  remove(id) {
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (this.data.activeId === id) this.data.activeId = this.data.accounts[0]?.id ?? null;
    this.save();
    return this.list();
  }

  setActive(id) {
    if (!this.data.accounts.some((a) => a.id === id)) throw new Error('Compte introuvable.');
    this.data.activeId = id;
    this.save();
    return this.list();
  }

  /**
   * Jetons d'un compte Microsoft, renouvelés s'ils expirent dans moins de 10 minutes
   * (ou tout de suite avec `force`). `log` reçoit les messages à afficher dans la console.
   */
  async freshSecrets(account, log = () => {}, { force = false } = {}) {
    let secrets;
    try {
      secrets = JSON.parse(this.vault.decrypt(account.secrets));
    } catch {
      account.needsLogin = true;
      this.save();
      throw new Error(`Impossible de lire la session de ${account.name} : reconnecte ce compte.`);
    }

    if (force || Date.now() > secrets.expiresAt - RENEW_MARGIN_MS) {
      if (!this.renew) throw new Error("La connexion Microsoft n'est pas configurée dans ce launcher.");
      try {
        log('Renouvellement de la session Microsoft…');
        const session = await this.renew(secrets.refreshToken);
        this.addMicrosoft(session, { activate: false }); // remplace l'entrée (et efface needsLogin)
        secrets = { refreshToken: session.refreshToken, accessToken: session.accessToken, expiresAt: session.expiresAt };
      } catch (error) {
        // Hors connexion : le dernier jeton suffit pour jouer en solo.
        if (error.code === 'NETWORK') log(`Session non renouvelée (${error.message}) : le multijoueur en ligne risque de refuser la connexion.`);
        else {
          account.needsLogin = true;
          this.save();
          throw error;
        }
      }
    }

    return secrets;
  }

  /** Lance `action(jeton)` pour un compte Microsoft. Si Minecraft refuse le jeton (401), une seule reprise avec un jeton neuf. */
  async withToken(id, action) {
    const account = this.get(id);
    if (account.type !== 'microsoft') throw new Error('Il faut un compte Microsoft pour cela.');
    const { accessToken } = await this.freshSecrets(account);
    try {
      return await action(accessToken);
    } catch (error) {
      if (error.code !== 'UNAUTHORIZED') throw error;
      const secrets = await this.freshSecrets(this.get(id), () => {}, { force: true });
      return action(secrets.accessToken);
    }
  }

  /** Compte prêt pour le lancement : `id` (compte de l'instance) ou, à défaut, le compte actif. */
  async launchAccount(log = () => {}, id = this.data.activeId) {
    const account = this.data.accounts.find((a) => a.id === id);
    if (!account) throw new Error('Ajoute un compte avant de jouer.');

    if (account.type === 'offline') {
      return { name: account.name, uuid: account.uuid, accessToken: crypto.randomBytes(16).toString('hex'), userType: 'legacy', xuid: '0', type: 'offline' };
    }

    const secrets = await this.freshSecrets(account, log);
    return { name: account.name, uuid: account.uuid, accessToken: secrets.accessToken, userType: 'msa', xuid: account.xuid ?? '0', type: 'microsoft' };
  }
}

module.exports = { AccountStore, offlineUuid };
