'use strict';

// Lecture du format NBT de Minecraft (big-endian), pour level.dat. Le launcher ne réécrit jamais ces fichiers.
// Référence : https://minecraft.wiki/w/NBT_format
const zlib = require('node:zlib');

const T = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 };
const MAX_DEPTH = 512;

class Reader {
  constructor(buffer) {
    this.b = buffer;
    this.o = 0;
  }
  take(n) {
    if (n < 0 || this.o + n > this.b.length) throw new Error('NBT truncated');
    const start = this.o;
    this.o += n;
    return start;
  }
  byte() { return this.b.readInt8(this.take(1)); }
  short() { return this.b.readInt16BE(this.take(2)); }
  int() { return this.b.readInt32BE(this.take(4)); }
  long() { return this.b.readBigInt64BE(this.take(8)); }
  string() {
    const length = this.b.readUInt16BE(this.take(2));
    const start = this.take(length);
    return this.b.toString('utf8', start, start + length);
  }
  payload(type, depth = 0) {
    if (depth > MAX_DEPTH) throw new Error('NBT too deep');
    switch (type) {
      case T.BYTE: return this.byte();
      case T.SHORT: return this.short();
      case T.INT: return this.int();
      case T.LONG: return this.long();
      case T.FLOAT: return this.b.readFloatBE(this.take(4));
      case T.DOUBLE: return this.b.readDoubleBE(this.take(8));
      case T.BYTE_ARRAY: {
        const start = this.take(this.int());
        return this.b.subarray(start, this.o);
      }
      case T.STRING: return this.string();
      case T.LIST: {
        const itemType = this.byte();
        const n = this.int();
        const items = [];
        for (let i = 0; i < n; i++) items.push(this.payload(itemType, depth + 1));
        return items;
      }
      case T.COMPOUND: {
        const entries = [];
        for (;;) {
          const tagType = this.byte();
          if (tagType === T.END) break;
          const name = this.string();
          entries.push({ name, value: this.payload(tagType, depth + 1) });
        }
        return entries;
      }
      case T.INT_ARRAY: {
        const n = this.int();
        this.take(n * 4);
        return null; // jamais utile ici
      }
      case T.LONG_ARRAY: {
        const n = this.int();
        this.take(n * 8);
        return null;
      }
      default:
        throw new Error(`NBT type ${type}`);
    }
  }
}

/** Lit un fichier NBT (gzip ou non). Renvoie la liste d'entrées du compound racine. */
function parse(buffer) {
  const data = buffer[0] === 0x1f && buffer[1] === 0x8b ? zlib.gunzipSync(buffer, { maxOutputLength: 64 * 1024 * 1024 }) : buffer;
  const reader = new Reader(data);
  if (reader.byte() !== T.COMPOUND) throw new Error('NBT root');
  reader.string();
  return reader.payload(T.COMPOUND);
}

/** Valeur d'une entrée d'un compound (ou undefined). */
function get(compound, name) {
  return Array.isArray(compound) ? compound.find((e) => e?.name === name)?.value : undefined;
}

module.exports = { parse, get };
