'use strict';

// Serveurs d'une instance : servers.dat (le même fichier que le menu Multijoueur du jeu) et ping en direct.
// Protocole : https://minecraft.wiki/w/Java_Edition_protocol/Server_List_Ping
const dns = require('node:dns').promises;
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const nbt = require('./nbt');

const DEFAULT_PORT = 25565;
const PING_TIMEOUT = 5000;
const MAX_RESPONSE = 1024 * 1024; // une icône 64×64 + le MOTD tiennent largement dedans

// ---------- servers.dat ----------

const serversFile = (gameDir) => path.join(gameDir, 'servers.dat');

function readFile(gameDir) {
  const file = serversFile(gameDir);
  if (!fs.existsSync(file)) return { name: '', value: [] };
  return nbt.parse(fs.readFileSync(file));
}

/** Entrées brutes de la liste (compounds NBT), dans l'ordre du jeu. */
function rawEntries(root) {
  const list = nbt.get(root.value, 'servers');
  return list?.itemType === nbt.T.COMPOUND ? list.items : [];
}

function writeEntries(gameDir, root, entries) {
  nbt.set(root.value, 'servers', nbt.T.LIST, { itemType: nbt.T.COMPOUND, items: entries });
  const file = serversFile(gameDir);
  fs.mkdirSync(gameDir, { recursive: true });
  // Comme le jeu : l'ancienne version reste dans servers.dat_old.
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}_old`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, nbt.serialize(root));
  fs.renameSync(tmp, file);
}

const PACKS = { 1: 'enabled', 0: 'disabled' };

function toServer(entry, index) {
  const icon = nbt.get(entry, 'icon');
  const packs = nbt.get(entry, 'acceptTextures');
  return {
    index,
    name: nbt.get(entry, 'name') ?? '',
    address: nbt.get(entry, 'ip') ?? '',
    icon: typeof icon === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(icon) ? `data:image/png;base64,${icon.replace(/\s/g, '')}` : null,
    resourcePacks: PACKS[packs] ?? 'prompt',
  };
}

/** Serveurs visibles dans le menu Multijoueur (le jeu cache ceux ajoutés par « Connexion directe »). */
function listServers(gameDir) {
  return rawEntries(readFile(gameDir))
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => nbt.get(entry, 'hidden') !== 1)
    .map(({ entry, index }) => toServer(entry, index));
}

function checkServer({ name, address, resourcePacks } = {}) {
  const cleanName = typeof name === 'string' ? name.trim().slice(0, 64) : '';
  const cleanAddress = typeof address === 'string' ? address.trim() : '';
  if (!cleanAddress) throw new Error("Indique l'adresse du serveur.");
  parseAddress(cleanAddress); // valide le format
  return {
    name: cleanName || 'Serveur Minecraft',
    address: cleanAddress,
    resourcePacks: ['enabled', 'disabled', 'prompt'].includes(resourcePacks) ? resourcePacks : 'prompt',
  };
}

function applyServer(entry, server) {
  nbt.set(entry, 'name', nbt.T.STRING, server.name);
  nbt.set(entry, 'ip', nbt.T.STRING, server.address);
  const packs = { enabled: 1, disabled: 0 }[server.resourcePacks];
  nbt.set(entry, 'acceptTextures', nbt.T.BYTE, packs);
  return entry;
}

function edit(gameDir, change) {
  const root = readFile(gameDir);
  const entries = rawEntries(root).slice();
  change(entries);
  writeEntries(gameDir, root, entries);
  return listServers(gameDir);
}

function entryAt(entries, index) {
  if (!Number.isInteger(index) || !entries[index]) throw new Error('Serveur introuvable : la liste a peut-être changé dans le jeu.');
  return entries[index];
}

const addServer = (gameDir, data) => {
  const server = checkServer(data);
  return edit(gameDir, (entries) => entries.push(applyServer([], server)));
};

const updateServer = (gameDir, index, data) => {
  const server = checkServer(data);
  return edit(gameDir, (entries) => applyServer(entryAt(entries, index), server));
};

const removeServer = (gameDir, index) =>
  edit(gameDir, (entries) => {
    entryAt(entries, index);
    entries.splice(index, 1);
  });

/** Déplace un serveur à la place d'un autre (indices bruts de servers.dat). */
const moveServer = (gameDir, from, to) =>
  edit(gameDir, (entries) => {
    entryAt(entries, from);
    entryAt(entries, to);
    entries.splice(to, 0, ...entries.splice(from, 1));
  });

/** Enregistre l'icône renvoyée par le ping, comme le fait le jeu (affichée même hors connexion). */
function saveIcon(gameDir, index, address, favicon) {
  const root = readFile(gameDir);
  const entries = rawEntries(root);
  const entry = entries[index];
  if (!entry || nbt.get(entry, 'ip') !== address) return false;
  const icon = favicon?.startsWith('data:image/png;base64,') ? favicon.slice('data:image/png;base64,'.length).replace(/\s/g, '') : undefined;
  if (nbt.get(entry, 'icon') === icon) return false;
  nbt.set(entry, 'icon', nbt.T.STRING, icon);
  writeEntries(gameDir, root, entries);
  return true;
}

// ---------- Adresse ----------

/** « exemple.fr », « exemple.fr:25566 », « 1.2.3.4 », « [::1]:25565 » → { host, port, explicitPort }. */
function parseAddress(address) {
  const text = String(address ?? '').trim();
  let host = text;
  let port = null;
  const bracket = text.match(/^\[([0-9a-fA-F:.]+)\](?::(\d+))?$/);
  if (bracket) {
    host = bracket[1];
    port = bracket[2] ?? null;
  } else if ((text.match(/:/g) ?? []).length === 1) {
    [host, port] = text.split(':');
  } else if (text.includes(':') && !net.isIPv6(text)) {
    throw new Error(`Adresse invalide : ${text}`);
  }
  if (!host || !/^[\w.:-]+$/.test(host)) throw new Error(`Adresse invalide : ${text}`);
  const number = port === null ? DEFAULT_PORT : Number(port);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`Port invalide : ${port}`);
  return { host, port: number, explicitPort: port !== null };
}

/** Sans port précisé, le jeu cherche d'abord un enregistrement SRV « _minecraft._tcp ». */
async function resolveTarget(address) {
  const target = parseAddress(address);
  if (target.explicitPort || net.isIP(target.host)) return target;
  try {
    const [srv] = await dns.resolveSrv(`_minecraft._tcp.${target.host}`);
    if (srv?.name) return { host: srv.name, port: srv.port, explicitPort: true, srvFrom: target.host };
  } catch {
    // Pas d'enregistrement SRV : adresse telle quelle.
  }
  return target;
}

// ---------- Ping ----------

function varInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    bytes.push(byte);
  } while (v);
  return Buffer.from(bytes);
}

function packet(id, ...fields) {
  const body = Buffer.concat([varInt(id), ...fields]);
  return Buffer.concat([varInt(body.length), body]);
}

const mcString = (text) => {
  const data = Buffer.from(text, 'utf8');
  return Buffer.concat([varInt(data.length), data]);
};

/** Lit un VarInt ; renvoie null s'il manque des octets. */
function readVarInt(buffer, offset) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buffer.length) return null;
    const byte = buffer[offset + i];
    value |= (byte & 0x7f) << (7 * i);
    if (!(byte & 0x80)) return { value, size: i + 1 };
  }
  throw new Error('Réponse du serveur illisible.');
}

/** Ouvre une connexion TCP et donne les octets reçus à `onData` jusqu'à ce qu'il renvoie un résultat. */
function exchange({ host, port, signal }, send, onData) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let received = Buffer.alloc(0);
    let finished = false;
    const done = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => done(new Error('Ping annulé.'));
    const timer = setTimeout(() => done(Object.assign(new Error('Le serveur ne répond pas.'), { code: 'TIMEOUT' })), PING_TIMEOUT);
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => send(socket));
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > MAX_RESPONSE) return done(new Error('Réponse du serveur trop grande.'));
      try {
        const result = onData(received, socket);
        if (result !== undefined) done(null, result);
      } catch (error) {
        done(error);
      }
    });
    socket.once('error', (error) => done(error));
    socket.once('close', () => done(Object.assign(new Error('Le serveur a fermé la connexion.'), { code: 'CLOSED' })));
  });
}

/** Ping moderne (1.7+) : handshake, statut JSON, puis aller-retour pour la latence. */
function modernPing(target, signal) {
  let status = null;
  let sentAt = 0;
  const payload = Buffer.alloc(8);
  return exchange(
    { ...target, signal },
    (socket) => {
      const port = Buffer.alloc(2);
      port.writeUInt16BE(target.port);
      // Protocole -1 : « je ne sais pas », le serveur répond avec sa propre version.
      socket.write(Buffer.concat([packet(0x00, varInt(-1), mcString(target.srvFrom ?? target.host), port, varInt(1)), packet(0x00)]));
    },
    (buffer, socket) => {
      let offset = 0;
      for (;;) {
        const length = readVarInt(buffer, offset);
        if (!length || offset + length.size + length.value > buffer.length) return undefined;
        const start = offset + length.size;
        const id = readVarInt(buffer, start);
        const body = buffer.subarray(start + id.size, start + length.value);
        offset = start + length.value;
        if (id.value === 0x00 && !status) {
          const size = readVarInt(body, 0);
          status = JSON.parse(body.toString('utf8', size.size, size.size + size.value));
          sentAt = performance.now();
          payload.writeBigInt64BE(BigInt(Date.now()));
          socket.write(packet(0x01, payload));
        } else if (id.value === 0x01 && status) {
          return { status, latency: Math.max(1, Math.round(performance.now() - sentAt)) };
        }
      }
    },
  ).catch((error) => {
    // Le statut est arrivé mais pas la réponse au ping : on garde le statut.
    if (status) return { status, latency: null };
    throw error;
  });
}

/** Ping des anciens serveurs (avant 1.7) : 0xFE 0x01, réponse « §1\0protocole\0version\0MOTD\0joueurs\0max » en UTF-16. */
function legacyPing(target, signal) {
  const started = performance.now();
  return exchange(
    { ...target, signal },
    (socket) => socket.write(Buffer.from([0xfe, 0x01])),
    (buffer) => {
      if (buffer[0] !== 0xff) throw new Error('Réponse du serveur illisible.');
      if (buffer.length < 3) return undefined;
      const chars = buffer.readUInt16BE(1);
      if (buffer.length < 3 + chars * 2) return undefined;
      const text = buffer.subarray(3, 3 + chars * 2).swap16().toString('utf16le');
      const latency = Math.max(1, Math.round(performance.now() - started));
      if (text.startsWith('§1\0')) {
        const [, , version, motd, online, max] = text.split('\0');
        return { status: { version: { name: version }, description: motd, players: { online: Number(online), max: Number(max) } }, latency };
      }
      // Très anciens serveurs (beta → 1.3) : « MOTD§joueurs§max ».
      const [motd, online, max] = text.split('§');
      return { status: { version: { name: 'Ancienne version' }, description: motd, players: { online: Number(online), max: Number(max) } }, latency };
    },
  );
}

/**
 * Interroge un serveur. Renvoie { online: true, motd, players, version, favicon, latency }
 * ou { online: false, error } (jamais d'exception pour un serveur hors ligne).
 */
async function pingServer(address, { signal } = {}) {
  let target;
  try {
    target = await resolveTarget(address);
  } catch (error) {
    return { online: false, error: error.message };
  }
  try {
    let result;
    try {
      result = await modernPing(target, signal);
    } catch (error) {
      // Un serveur d'avant 1.7 ne comprend pas le handshake et coupe la connexion.
      if (error.code !== 'CLOSED' && error.code !== 'ECONNRESET') throw error;
      result = await legacyPing(target, signal);
    }
    return summarize(result);
  } catch (error) {
    return { online: false, error: pingError(error) };
  }
}

function pingError(error) {
  switch (error.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Adresse introuvable.';
    case 'ECONNREFUSED':
      return 'Connexion refusée : le serveur est éteint ou le port est faux.';
    case 'TIMEOUT':
    case 'ETIMEDOUT':
      return 'Le serveur ne répond pas.';
    case 'ECONNRESET':
    case 'CLOSED':
      return 'Le serveur a fermé la connexion.';
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
      return 'Réseau injoignable.';
    default:
      return error.message;
  }
}

function summarize({ status, latency }) {
  const players = status.players ?? {};
  const sample = Array.isArray(players.sample)
    ? players.sample.map((p) => stripCodes(String(p?.name ?? ''))).filter(Boolean).slice(0, 12)
    : [];
  const favicon = typeof status.favicon === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/.test(status.favicon) ? status.favicon.replace(/\s/g, '') : null;
  return {
    online: true,
    motd: motdSegments(status.description),
    players: { online: Number(players.online) || 0, max: Number(players.max) || 0, sample },
    version: { name: stripCodes(String(status.version?.name ?? '')), protocol: Number(status.version?.protocol) || null },
    favicon,
    latency,
  };
}

// ---------- MOTD ----------

const COLORS = {
  black: '#000000', dark_blue: '#0000AA', dark_green: '#00AA00', dark_aqua: '#00AAAA',
  dark_red: '#AA0000', dark_purple: '#AA00AA', gold: '#FFAA00', gray: '#AAAAAA',
  dark_gray: '#555555', blue: '#5555FF', green: '#55FF55', aqua: '#55FFFF',
  red: '#FF5555', light_purple: '#FF55FF', yellow: '#FFFF55', white: '#FFFFFF',
};
const CODE_COLORS = Object.values(COLORS); // §0 → §f, dans le même ordre
const FORMATS = { l: 'bold', m: 'strikethrough', n: 'underlined', o: 'italic' };

const stripCodes = (text) => text.replace(/§[0-9a-fk-orx]/gi, '');

function colorOf(value) {
  if (typeof value !== 'string') return undefined;
  if (COLORS[value]) return COLORS[value];
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toUpperCase() : undefined;
}

/** Texte avec codes « § » → segments stylés. */
function legacySegments(text, base, out) {
  let style = { ...base };
  for (const [index, part] of String(text).split('§').entries()) {
    let chunk = part;
    if (index > 0 && chunk) {
      const code = chunk[0].toLowerCase();
      chunk = chunk.slice(1);
      const color = '0123456789abcdef'.indexOf(code);
      if (color >= 0) style = { ...base, color: CODE_COLORS[color] }; // une couleur annule la mise en forme
      else if (FORMATS[code]) style = { ...style, [FORMATS[code]]: true };
      else if (code === 'r') style = { ...base };
    }
    if (chunk) out.push({ text: chunk, ...style });
  }
}

/** Composant de texte JSON (chaîne, tableau ou objet avec `extra`) → segments. */
function componentSegments(component, base, out, depth = 0) {
  if (depth > 16 || component == null) return;
  if (typeof component === 'string' || typeof component === 'number') return legacySegments(component, base, out);
  if (Array.isArray(component)) {
    // Dans un tableau, le premier élément sert de parent aux suivants.
    const [first, ...rest] = component;
    const parentStyle = typeof first === 'object' && first && !Array.isArray(first) ? styleOf(first, base) : base;
    componentSegments(first, base, out, depth + 1);
    for (const child of rest) componentSegments(child, parentStyle, out, depth + 1);
    return;
  }
  if (typeof component !== 'object') return;
  const style = styleOf(component, base);
  const text = component.text ?? component.translate ?? '';
  if (text !== '') legacySegments(text, style, out);
  for (const child of Array.isArray(component.extra) ? component.extra : []) componentSegments(child, style, out, depth + 1);
}

function styleOf(component, base) {
  const style = { ...base };
  const color = colorOf(component.color);
  if (color) style.color = color;
  for (const key of ['bold', 'italic', 'underlined', 'strikethrough']) {
    if (typeof component[key] === 'boolean') style[key] = component[key];
  }
  return style;
}

function motdSegments(description) {
  const out = [];
  componentSegments(description, {}, out);
  // Bornes contre les MOTD démesurés.
  return out.slice(0, 200).map((segment) => ({ ...segment, text: segment.text.slice(0, 200) }));
}

module.exports = {
  listServers,
  addServer,
  updateServer,
  removeServer,
  moveServer,
  saveIcon,
  parseAddress,
  resolveTarget,
  pingServer,
  motdSegments,
};
