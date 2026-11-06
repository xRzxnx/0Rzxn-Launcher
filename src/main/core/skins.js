'use strict';

// Skins et capes : profils publics de Mojang, textures en cache, « Mes skins » sur le disque
// et envoi au compte Microsoft. Référence : https://minecraft.wiki/w/Mojang_API
const { formatDate, t } = require('../i18n');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const microsoft = require('./microsoft');
const { exists, readJson, writeJson } = require('./store');

const LOOKUP = 'https://api.minecraftservices.com/minecraft/profile/lookup/name';
const SESSION = 'https://sessionserver.mojang.com/session/minecraft/profile';
const TEXTURES = 'https://textures.minecraft.net/texture';
const USER_AGENT = '0Rzxn_Launcher/0.1 (launcher Minecraft personnel)';
const TIMEOUT_MS = 15_000;
const MAX_PNG = 2 * 1024 * 1024; // garde-fou local : Mojang ne publie pas de limite
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const LOOK_TTL_MS = 30 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000; // après un refus de Mojang (429) : des refus répétés peuvent suspendre le compte

const HASH = /^[0-9a-f]{32,64}$/;
const VARIANTS = new Set(['classic', 'slim']);

const cleanVariant = (value) => (VARIANTS.has(String(value).toLowerCase()) ? String(value).toLowerCase() : 'classic');

/** Empreinte d'une texture de Mojang ; null pour toute autre adresse. */
function textureHash(url) {
  const match = /^https?:\/\/textures\.minecraft\.net\/texture\/([0-9a-f]{32,64})$/i.exec(String(url ?? ''));
  return match ? match[1].toLowerCase() : null;
}

function pngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Vérifie qu'un fichier est un skin que le jeu accepte ; renvoie sa taille. */
function checkSkin(buffer) {
  if (buffer.length > MAX_PNG) throw new Error(t('common.ce_fichier_est_trop_lourd'));
  const size = pngSize(buffer);
  if (!size) throw new Error(t('skins.ce_fichier_est_pas_une'));
  if (size.width !== 64 || (size.height !== 64 && size.height !== 32)) {
    throw new Error(t('skins.un_skin_fait_64_64', { width: size.width, height: size.height }));
  }
  return size;
}

async function getPublic(url) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new Error(t('skins.mojang_ne_repond_pas', { code: error.cause?.code ?? error.message }));
  }
  if (res.status === 404 || res.status === 204) return null;
  if (res.status === 429) throw new Error(t('skins.trop_de_requetes_vers_mojang'));
  if (!res.ok) throw new Error(t('skins.mojang_repondu', { status: res.status }));
  return res.json();
}

/** { uuid, name } du joueur qui possède ce pseudo, ou null. */
async function lookupPlayer(name) {
  const body = await getPublic(`${LOOKUP}/${encodeURIComponent(name)}`);
  return body?.id ? { uuid: body.id, name: body.name } : null;
}

/** Skin et cape publics d'un joueur, d'après le serveur de sessions. */
async function publicLook(uuid) {
  const body = await getPublic(`${SESSION}/${encodeURIComponent(uuid)}`);
  const encoded = body?.properties?.find((p) => p.name === 'textures')?.value;
  if (!encoded) return { skin: null, cape: null };
  const { textures = {} } = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  const skinHash = textureHash(textures.SKIN?.url);
  const capeHash = textureHash(textures.CAPE?.url);
  return {
    skin: skinHash ? { hash: skinHash, variant: cleanVariant(textures.SKIN.metadata?.model) } : null,
    cape: capeHash ? { hash: capeHash } : null,
  };
}

function cleanName(raw) {
  // eslint-disable-next-line no-control-regex
  const name = String(raw ?? '').replace(/\.png$/i, '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
  return name.slice(0, 24) || 'Skin';
}

/** Cache des textures de Mojang et bibliothèque « Mes skins » (un PNG par skin et library.json). */
class SkinStore {
  constructor(dirs) {
    this.cacheDir = path.join(dirs.cache, 'skins');
    this.dir = dirs.skins;
    this.file = path.join(dirs.skins, 'library.json');
    this.items = readJson(this.file, []);
    this.downloads = new Map();
  }

  list() {
    return [...this.items].sort((a, b) => b.addedAt - a.addedAt).map(({ id, name, variant, legacy }) => ({ id, name, variant, legacy: Boolean(legacy) }));
  }

  has(id) {
    return this.items.some((item) => item.id === id);
  }

  skinFile(id) {
    if (!this.has(id)) throw new Error(t('skins.ce_skin_est_plus_dans'));
    return path.join(this.dir, `${id}.png`);
  }

  /** Ajoute un PNG. Le même fichier n'est gardé qu'une fois. */
  add(png, { name, variant }) {
    const { height } = checkSkin(png);
    const id = crypto.createHash('sha256').update(png).digest('hex').slice(0, 32);
    const known = this.items.find((item) => item.id === id);
    if (known) return { item: known, added: false };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${id}.png`), png);
    const item = { id, name: cleanName(name), variant: cleanVariant(variant), legacy: height === 32, addedAt: Date.now() };
    this.items.push(item);
    writeJson(this.file, this.items);
    return { item, added: true };
  }

  setVariant(id, variant) {
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new Error(t('skins.ce_skin_est_plus_dans'));
    item.variant = cleanVariant(variant);
    writeJson(this.file, this.items);
  }

  remove(id) {
    if (!this.has(id)) return;
    fs.rmSync(path.join(this.dir, `${id}.png`), { force: true });
    this.items = this.items.filter((item) => item.id !== id);
    writeJson(this.file, this.items);
  }

  /** Chemin local d'une texture de Mojang, téléchargée à la première demande. */
  texture(rawHash) {
    const hash = String(rawHash ?? '').toLowerCase();
    if (!HASH.test(hash)) return Promise.reject(new Error(t('skins.texture_inconnue')));
    const file = path.join(this.cacheDir, `${hash}.png`);
    if (exists(file)) return Promise.resolve(file);
    if (this.downloads.has(hash)) return this.downloads.get(hash);
    const job = this.download(hash, file).finally(() => this.downloads.delete(hash));
    this.downloads.set(hash, job);
    return job;
  }

  async download(hash, file) {
    let res;
    try {
      res = await fetch(`${TEXTURES}/${hash}`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new Error(t('skins.texture_indisponible', { code: error.cause?.code ?? error.message }));
    }
    if (!res.ok) throw new Error(t('skins.texture_indisponible_2', { status: res.status }));
    const png = Buffer.from(await res.arrayBuffer());
    if (png.length > MAX_PNG || !pngSize(png)) throw new Error(t('skins.texture_illisible'));
    this.putTexture(hash, png);
    return file;
  }

  putTexture(hash, png) {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(path.join(this.cacheDir, `${hash}.png`), png);
  }
}

/** Lie les comptes aux skins : apparence publique, profil Minecraft, envoi vers Mojang. */
class Wardrobe {
  /** `api` remplace les appels de core/microsoft.js dans les tests. */
  constructor({ accounts, store, api = microsoft }) {
    this.accounts = accounts;
    this.store = store;
    this.api = api;
    this.tried = new Map();
    this.cooldowns = new Map(); // compte → fin du blocage après un 429
    this.refreshing = null;
  }

  /** Une texture de 64×32 est un ancien format : le jeu copie alors le bras et la jambe droits à gauche. */
  async withFormat(skin) {
    if (!skin) return null;
    try {
      const { height } = pngSize(await fsp.readFile(await this.store.texture(skin.hash))) ?? {};
      return { ...skin, legacy: height === 32 };
    } catch {
      return { ...skin, legacy: false };
    }
  }

  /** Têtes des comptes, depuis l'API publique. Hors connexion, la dernière apparence connue reste. */
  refresh() {
    this.refreshing ??= this.refreshAll().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async refreshAll() {
    for (const account of this.accounts.all()) {
      const now = Date.now();
      if (now - (account.look?.checkedAt ?? 0) < LOOK_TTL_MS || now - (this.tried.get(account.id) ?? 0) < RETRY_MS) continue;
      this.tried.set(account.id, now);
      try {
        const uuid = account.type === 'microsoft' ? account.uuid : (await lookupPlayer(account.name))?.uuid;
        const look = uuid ? await publicLook(uuid) : { skin: null, cape: null };
        const previous = account.look?.skin;
        const skin = await this.withFormat(look.skin);
        if (skin && previous?.hash === skin.hash && previous.libraryId) skin.libraryId = previous.libraryId;
        this.accounts.setLook(account.id, { ...account.look, skin, cape: look.cape, checkedAt: Date.now() });
      } catch {
        // hors connexion ou Mojang indisponible : on réessaiera plus tard
      }
    }
    return this.accounts.list();
  }

  /** Enregistre le profil renvoyé par l'API Minecraft (skin actif et capes du compte). */
  async saveProfile(id, profile, libraryId = null) {
    const previous = this.accounts.get(id).look?.skin;
    const active = profile.skins?.find((s) => s.state === 'ACTIVE') ?? null;
    const hash = textureHash(active?.url);
    const skin = await this.withFormat(hash ? { hash, variant: cleanVariant(active.variant) } : null);
    const kept = libraryId ?? (previous?.hash === hash ? previous?.libraryId : null);
    if (skin && kept) skin.libraryId = kept;
    const capes = (profile.capes ?? [])
      .map((c) => ({ id: c.id, alias: String(c.alias ?? t('skins.cape')).slice(0, 30), hash: textureHash(c.url), active: c.state === 'ACTIVE' }))
      .filter((c) => c.id && c.hash);
    const cape = capes.find((c) => c.active);
    this.accounts.setLook(id, { skin, cape: cape ? { hash: cape.hash } : null, capes, checkedAt: Date.now() });
  }

  snapshot(id, problem = null) {
    const account = this.accounts.list().accounts.find((a) => a.id === id) ?? null;
    // L'empreinte de Mojang est celle du fichier : un skin copié depuis Mojang est reconnu dans « Mes skins ».
    const skin = account?.look?.skin;
    if (skin && !skin.libraryId && this.store.has(skin.hash.slice(0, 32))) account.look = { ...account.look, skin: { ...skin, libraryId: skin.hash.slice(0, 32) } };
    return {
      account,
      library: this.store.list(),
      cooldownUntil: Math.max(this.cooldowns.get(id) ?? 0, 0),
      error: problem?.message ?? null,
      errorCode: problem?.code ?? null,
    };
  }

  /** État de la fenêtre « Skin et cape ». Pour Microsoft, le profil à jour est relu chez Mojang. */
  async state(id) {
    const account = this.accounts.get(id);
    if (account.type !== 'microsoft' || account.needsLogin) return this.snapshot(id);
    try {
      await this.saveProfile(id, await this.accounts.withToken(id, (token) => this.api.fullProfile(token)));
      return this.snapshot(id);
    } catch (error) {
      return this.snapshot(id, error);
    }
  }

  /** Appel à Mojang qui demande un jeton. Jamais de nouvel essai après un 429. */
  async guarded(id, action) {
    const until = this.cooldowns.get(id) ?? 0;
    if (Date.now() < until) throw new microsoft.MicrosoftAuthError(t('skins.mojang_limite_les_changements_de'), 'RATE_LIMIT');
    try {
      return await this.accounts.withToken(id, action);
    } catch (error) {
      if (error.code === 'RATE_LIMIT') this.cooldowns.set(id, Date.now() + Math.max(COOLDOWN_MS, (error.retryAfter ?? 0) * 1000));
      throw error;
    }
  }

  /** Mojang ne donne pas d'historique : le skin remplacé reste dans « Mes skins ». */
  async keepCurrent(id) {
    const current = this.accounts.get(id).look?.skin;
    if (!current || current.libraryId) return;
    try {
      const png = await fsp.readFile(await this.store.texture(current.hash));
      const date = formatDate(new Date(), { day: '2-digit', month: '2-digit' });
      this.store.add(png, { name: t('skins.ancien_skin', { date }), variant: current.variant });
    } catch {
      // sans la texture, le changement reste possible
    }
  }

  requireMicrosoft(id) {
    if (this.accounts.get(id).type !== 'microsoft') throw new Error(t('skins.il_faut_un_compte_microsoft'));
  }

  async sourcePng(source) {
    if (source?.library) return fsp.readFile(this.store.skinFile(String(source.library)));
    if (source?.texture) return fsp.readFile(await this.store.texture(source.texture));
    throw new Error(t('skins.choisis_un_skin'));
  }

  /**
   * Applique un changement sur le compte. `skin` : { library } ou { texture } ; `cape` : identifiant,
   * null pour la masquer, undefined pour ne pas y toucher. Si la cape échoue, le skin reste appliqué.
   */
  async apply(id, { skin, variant, cape } = {}) {
    this.requireMicrosoft(id);
    if (skin) {
      const png = await this.sourcePng(skin);
      checkSkin(png);
      await this.keepCurrent(id);
      const profile = await this.guarded(id, (token) => this.api.uploadSkin(token, { png, variant: cleanVariant(variant) }));
      const active = profile.skins?.find((s) => s.state === 'ACTIVE');
      const hash = textureHash(active?.url);
      if (hash) this.store.putTexture(hash, png);
      await this.saveProfile(id, profile, skin.library ? String(skin.library) : null);
    }
    if (cape !== undefined) {
      const known = this.accounts.get(id).look?.capes ?? [];
      if (cape !== null && !known.some((c) => c.id === cape)) throw new Error(t('skins.cette_cape_appartient_pas_ce'));
      await this.saveProfile(id, await this.guarded(id, (token) => (cape === null ? this.api.hideCape(token) : this.api.showCape(token, cape))));
    }
    return this.snapshot(id);
  }

  /** Remet le skin par défaut de Minecraft ; l'ancien reste dans « Mes skins ». */
  async reset(id) {
    this.requireMicrosoft(id);
    await this.keepCurrent(id);
    await this.saveProfile(id, await this.guarded(id, (token) => this.api.resetSkin(token)));
    return this.snapshot(id);
  }

  /** Copie le skin public d'un joueur dans « Mes skins ». Rien n'est envoyé. */
  async copyPlayer(rawName) {
    const name = String(rawName ?? '').trim();
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error(t('skins.ce_pseudo_est_pas_valide'));
    const player = await lookupPlayer(name);
    if (!player) throw new Error(t('skins.aucun_joueur_ne_appelle', { name }));
    const { skin } = await publicLook(player.uuid);
    if (!skin) throw new Error(t('skins.pas_de_skin_personnalise', { name: player.name }));
    const png = await fsp.readFile(await this.store.texture(skin.hash));
    return this.store.add(png, { name: player.name, variant: skin.variant });
  }
}

module.exports = { SkinStore, Wardrobe, checkSkin, cleanVariant, lookupPlayer, pngSize, publicLook, textureHash };
