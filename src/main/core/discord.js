'use strict';

// Discord Rich Presence : le launcher parle à l'application Discord du PC par son canal local
// (\\?\pipe\discord-ipc-N sous Windows), sans passer par Internet. Trames : opcode, longueur, JSON.
const { t } = require('../i18n');
const net = require('node:net');
const os = require('node:os');
const crypto = require('node:crypto');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const TIMEOUT = 5000;

function pipeCandidates(override) {
  if (override) return [override];
  const base =
    process.platform === 'win32'
      ? '\\\\?\\pipe\\'
      : `${(process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || os.tmpdir()).replace(/\/$/, '')}/`;
  return Array.from({ length: 10 }, (_, i) => `${base}discord-ipc-${i}`);
}

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data), 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

function connectTo(pipe) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(TIMEOUT, () => fail(new Error('timeout')));
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.removeListener('error', fail);
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

class DiscordPresence {
  /** `clientId` : Application ID Discord ; `pipe` : canal imposé (tests). */
  constructor({ clientId, pipe = null }) {
    this.clientId = clientId;
    this.pipe = pipe;
    this.socket = null;
    this.ready = null; // promesse de connexion + poignée de main
    this.pending = new Map(); // nonce → { resolve, reject, timer }
    this.buffer = Buffer.alloc(0);
    this.activity = null; // dernière activité demandée (renvoyée après une reconnexion)
  }

  /** Discord est-il ouvert ? Ouvre le canal puis le referme, sans rien envoyer. */
  async isRunning() {
    if (this.socket) return true;
    for (const pipe of pipeCandidates(this.pipe)) {
      try {
        (await connectTo(pipe)).destroy();
        return true;
      } catch {
        // canal suivant
      }
    }
    return false;
  }

  connect() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      let socket = null;
      for (const pipe of pipeCandidates(this.pipe)) {
        try {
          socket = await connectTo(pipe);
          break;
        } catch {
          // canal suivant
        }
      }
      if (!socket) throw new Error(t('discord.discord_est_pas_ouvert'));
      this.socket = socket;
      this.buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => this.receive(chunk));
      socket.on('close', () => this.reset(new Error(t('discord.discord_ferme_la_connexion'))));
      socket.on('error', () => {});
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(t('discord.discord_ne_repond_pas'))), TIMEOUT);
        this.pending.set('READY', { resolve, reject, timer });
        socket.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
      });
    })();
    this.ready.catch(() => this.reset());
    return this.ready;
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);
      if (this.buffer.length < 8 + length) return;
      let data = null;
      try {
        data = JSON.parse(this.buffer.subarray(8, 8 + length).toString('utf8'));
      } catch {
        // trame illisible : ignorée
      }
      this.buffer = this.buffer.subarray(8 + length);
      if (op === OP.PING) this.socket?.write(encode(OP.PONG, data));
      else if (op === OP.CLOSE) this.socket?.destroy();
      else if (op === OP.FRAME && data) this.dispatch(data);
    }
  }

  dispatch(message) {
    const key = message.cmd === 'DISPATCH' && message.evt === 'READY' ? 'READY' : message.nonce;
    const waiter = this.pending.get(key);
    if (!waiter) return;
    this.pending.delete(key);
    clearTimeout(waiter.timer);
    if (message.evt === 'ERROR') waiter.reject(new Error(message.data?.message ?? t('discord.erreur_de_discord')));
    else waiter.resolve(message.data);
  }

  reset(error = new Error(t('discord.connexion_discord_perdue'))) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    this.socket?.destroy();
    this.socket = null;
    this.ready = null;
  }

  async request(cmd, args) {
    await this.connect();
    const nonce = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(new Error(t('discord.discord_ne_repond_pas')));
      }, TIMEOUT);
      this.pending.set(nonce, { resolve, reject, timer });
      this.socket.write(encode(OP.FRAME, { cmd, args, nonce }));
    });
  }

  /** Affiche `activity` sur le profil, ou l'efface (null). Une connexion fermée est rouverte une fois. */
  async setActivity(activity) {
    this.activity = activity;
    if (!activity && !this.socket) return;
    const send = () => this.request('SET_ACTIVITY', { pid: process.pid, activity });
    try {
      await send();
    } catch (error) {
      if (!activity) return;
      this.reset();
      await send().catch(() => {
        throw error;
      });
    }
  }

  /** Efface le statut puis ferme le canal. */
  async close() {
    if (this.socket) await this.setActivity(null).catch(() => {});
    this.reset(new Error(t('discord.connexion_fermee')));
  }
}

/** Activité affichée pendant une partie : « Joue à Survie (26.3) » dans la liste des membres. */
function gameActivity({ instance, loaderName, mods, startedAt, showName }) {
  const activity = {
    type: 0,
    details: showName ? `${instance.name} (${instance.version})`.slice(0, 128) : `Minecraft ${instance.version}`,
    timestamps: { start: startedAt },
    assets: { large_image: 'logo', large_text: '0Rzxn_ Launcher' },
    // 2 = la ligne « details » remplace le nom de l'application dans « Joue à … ».
    status_display_type: 2,
  };
  if (showName) activity.state = [loaderName, mods ? `${mods} mod${mods > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ');
  return activity;
}

module.exports = { DiscordPresence, gameActivity, encode, OP };
