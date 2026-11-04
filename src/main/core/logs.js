'use strict';

// Lecture des logs du jeu. Avec la configuration de logs de Mojang, Minecraft écrit des événements
// XML (<log4j:Event>) sur sa sortie : on les transforme en lignes lisibles.

const EVENT_START = '<log4j:Event';
const EVENT_END = '</log4j:Event>';
// « [12:00:00] [Render thread/INFO]: message », ou avec le nom du logger comme Forge :
// « [12:00:00] [Render thread/INFO] [minecraft/SoundEngine]: message »
const PLAIN_LINE = /^\[(\d{2}:\d{2}:\d{2})\] \[([^\]]+)\](?: \[([^\]]+)\])?: ?(.*)$/;

function clock(date = new Date()) {
  return date.toLocaleTimeString('fr-FR', { hour12: false });
}

function attribute(xml, name) {
  return xml.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

function cdata(xml, tag) {
  return xml.match(new RegExp(`<log4j:${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></log4j:${tag}>`))?.[1];
}

class GameLogParser {
  /** `emit(line)` reçoit { time, tag, msg } ; `defaultTag` sert aux lignes brutes. */
  constructor(emit, defaultTag) {
    this.emit = emit;
    this.defaultTag = defaultTag;
    this.buffer = '';
  }

  push(chunk) {
    this.buffer += chunk;
    for (;;) {
      const start = this.buffer.indexOf(EVENT_START);
      if (start === -1) {
        const lastNewline = this.buffer.lastIndexOf('\n');
        if (lastNewline === -1) return;
        this.plain(this.buffer.slice(0, lastNewline));
        this.buffer = this.buffer.slice(lastNewline + 1);
        return;
      }
      if (start > 0) {
        this.plain(this.buffer.slice(0, start));
        this.buffer = this.buffer.slice(start);
        continue;
      }
      const end = this.buffer.indexOf(EVENT_END);
      if (end === -1) return;
      this.event(this.buffer.slice(0, end + EVENT_END.length));
      this.buffer = this.buffer.slice(end + EVENT_END.length);
    }
  }

  flush() {
    if (this.buffer.trim()) this.plain(this.buffer);
    this.buffer = '';
  }

  event(xml) {
    const timestamp = Number(attribute(xml, 'timestamp'));
    const time = clock(Number.isFinite(timestamp) ? new Date(timestamp) : new Date());
    const tag = `${attribute(xml, 'thread') ?? 'main'}/${attribute(xml, 'level') ?? 'INFO'}`;
    const text = [cdata(xml, 'Message'), cdata(xml, 'Throwable')].filter(Boolean).join('\n');
    for (const msg of text.split(/\r?\n/)) if (msg.trim()) this.emit({ time, tag, msg });
  }

  plain(text) {
    // Forge colore sa sortie (codes ANSI) et Java peut écrire « \r\r\n » sous Windows : on nettoie.
    for (const line of text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '').split('\n')) {
      if (!line.trim()) continue;
      const match = line.match(PLAIN_LINE);
      if (match) this.emit({ time: match[1], tag: match[2], msg: match[3] ? `[${match[3]}] ${match[4]}` : match[4] });
      else this.emit({ time: clock(), tag: this.defaultTag, msg: line });
    }
  }
}

/** Remplace les secrets (jeton de connexion…) par des points avant tout affichage. */
function censor(text, secrets) {
  let out = text;
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join('••••••••');
  return out;
}

module.exports = { GameLogParser, censor, clock };
