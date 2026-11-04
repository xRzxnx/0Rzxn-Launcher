'use strict';

// Format NBT de Minecraft (big-endian), lu et réécrit sans perte : chaque valeur garde son type.
// Utilisé pour servers.dat. Référence : https://minecraft.wiki/w/NBT_format
const zlib = require('node:zlib');

const T = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 };

class Reader {
  constructor(buffer) {
    this.b = buffer;
    this.o = 0;
  }
  take(n) {
    if (this.o + n > this.b.length) throw new Error('Fichier NBT tronqué.');
    const start = this.o;
    this.o += n;
    return start;
  }
  byte() { return this.b.readInt8(this.take(1)); }
  short() { return this.b.readInt16BE(this.take(2)); }
  int() { return this.b.readInt32BE(this.take(4)); }
  long() { return this.b.readBigInt64BE(this.take(8)); }
  float() { return this.b.readFloatBE(this.take(4)); }
  double() { return this.b.readDoubleBE(this.take(8)); }
  string() {
    const length = this.b.readUInt16BE(this.take(2));
    const start = this.take(length);
    return this.b.toString('utf8', start, start + length);
  }
  payload(type) {
    switch (type) {
      case T.BYTE: return this.byte();
      case T.SHORT: return this.short();
      case T.INT: return this.int();
      case T.LONG: return this.long();
      case T.FLOAT: return this.float();
      case T.DOUBLE: return this.double();
      case T.BYTE_ARRAY: {
        const n = this.int();
        const start = this.take(n);
        return Buffer.from(this.b.subarray(start, start + n));
      }
      case T.STRING: return this.string();
      case T.LIST: {
        const itemType = this.byte();
        const n = this.int();
        const items = [];
        for (let i = 0; i < n; i++) items.push(this.payload(itemType));
        return { itemType, items };
      }
      case T.COMPOUND: {
        const entries = [];
        for (;;) {
          const tagType = this.byte();
          if (tagType === T.END) break;
          const name = this.string();
          entries.push({ name, type: tagType, value: this.payload(tagType) });
        }
        return entries;
      }
      case T.INT_ARRAY: {
        const n = this.int();
        return Array.from({ length: n }, () => this.int());
      }
      case T.LONG_ARRAY: {
        const n = this.int();
        return Array.from({ length: n }, () => this.long());
      }
      default:
        throw new Error(`Type NBT inconnu : ${type}`);
    }
  }
}

/** Lit un fichier NBT (compressé gzip ou non). Renvoie { name, value } où value est la liste d'entrées du compound racine. */
function parse(buffer) {
  const data = buffer[0] === 0x1f && buffer[1] === 0x8b ? zlib.gunzipSync(buffer) : buffer;
  const reader = new Reader(data);
  if (reader.byte() !== T.COMPOUND) throw new Error("Ce fichier NBT ne commence pas par un compound.");
  const name = reader.string();
  return { name, value: reader.payload(T.COMPOUND) };
}

class Writer {
  constructor() {
    this.parts = [];
  }
  push(size, write) {
    const b = Buffer.alloc(size);
    write(b);
    this.parts.push(b);
  }
  byte(v) { this.push(1, (b) => b.writeInt8(v)); }
  short(v) { this.push(2, (b) => b.writeInt16BE(v)); }
  int(v) { this.push(4, (b) => b.writeInt32BE(v)); }
  long(v) { this.push(8, (b) => b.writeBigInt64BE(BigInt(v))); }
  string(v) {
    const data = Buffer.from(String(v), 'utf8');
    this.push(2, (b) => b.writeUInt16BE(data.length));
    this.parts.push(data);
  }
  payload(type, value) {
    switch (type) {
      case T.BYTE: return this.byte(value);
      case T.SHORT: return this.short(value);
      case T.INT: return this.int(value);
      case T.LONG: return this.long(value);
      case T.FLOAT: return this.push(4, (b) => b.writeFloatBE(value));
      case T.DOUBLE: return this.push(8, (b) => b.writeDoubleBE(value));
      case T.BYTE_ARRAY:
        this.int(value.length);
        return this.parts.push(Buffer.from(value));
      case T.STRING: return this.string(value);
      case T.LIST:
        this.byte(value.items.length ? value.itemType : T.END);
        this.int(value.items.length);
        return value.items.forEach((item) => this.payload(value.itemType, item));
      case T.COMPOUND:
        for (const entry of value) {
          this.byte(entry.type);
          this.string(entry.name);
          this.payload(entry.type, entry.value);
        }
        return this.byte(T.END);
      case T.INT_ARRAY:
        this.int(value.length);
        return value.forEach((v) => this.int(v));
      case T.LONG_ARRAY:
        this.int(value.length);
        return value.forEach((v) => this.long(v));
      default:
        throw new Error(`Type NBT inconnu : ${type}`);
    }
  }
}

/** Écrit un fichier NBT non compressé (comme servers.dat). */
function serialize({ name = '', value }) {
  const w = new Writer();
  w.byte(T.COMPOUND);
  w.string(name);
  w.payload(T.COMPOUND, value);
  return Buffer.concat(w.parts);
}

/** Valeur d'une entrée d'un compound (ou undefined). */
function get(compound, name) {
  return compound.find((e) => e.name === name)?.value;
}

/** Remplace ou ajoute une entrée dans un compound ; `undefined` la retire. */
function set(compound, name, type, value) {
  const index = compound.findIndex((e) => e.name === name);
  if (value === undefined) {
    if (index >= 0) compound.splice(index, 1);
    return;
  }
  if (index >= 0) compound[index] = { name, type, value };
  else compound.push({ name, type, value });
}

module.exports = { T, parse, serialize, get, set };
