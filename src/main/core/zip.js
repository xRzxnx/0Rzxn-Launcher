'use strict';

// ZIP minimal en mémoire : lecture (natives, mods, modpacks) et écriture (export de modpacks).
const { t } = require('../i18n');
const zlib = require('node:zlib');

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

function listEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(t('zip.archive_zip_invalide'));

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count && buffer.readUInt32LE(offset) === CENTRAL; n++) {
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(buffer, entry) {
  const local = entry.localOffset;
  const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
  const data = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(t('zip.compression_zip_non_geree_pour', { method: entry.method, name: entry.name }));
}

/** Contenu d'un fichier de l'archive par son nom, ou null s'il n'existe pas. */
function readFile(buffer, name, entries = listEntries(buffer)) {
  const entry = entries.find((e) => e.name === name);
  return entry ? readEntry(buffer, entry) : null;
}

/** Crée une archive ZIP (compression « deflate ») à partir de [{ name, data }]. */
function createZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const stored = compressed.length >= data.length;
    const body = stored ? data : compressed;
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version nécessaire
    local.writeUInt16LE(0x0800, 6); // noms en UTF-8
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + body.length;
  }
  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

module.exports = { listEntries, readEntry, readFile, createZip };
