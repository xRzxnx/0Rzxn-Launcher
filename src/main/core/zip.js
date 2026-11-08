'use strict';

// ZIP minimal : en mémoire (natives, mods, modpacks, export de modpacks) et, plus bas, archives sur disque
// avec ZIP64 (sauvegardes de mondes), écrites et lues fichier par fichier.
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

// ---------- Archives sur disque (sauvegardes de mondes), avec ZIP64 ----------

const fs = require('node:fs');
const { promisify } = require('node:util');

const deflateRaw = promisify(zlib.deflateRaw);
const inflateRaw = promisify(zlib.inflateRaw);
const MAX32 = 0xffffffff;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;

/** Date et heure au format MS-DOS (celui des en-têtes ZIP). */
function dosTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Écrit une archive ZIP fichier par fichier, sans tout charger en mémoire.
 * entries : [{ name, path }] ; onProgress({ done, total }). Écrit d'abord un « .part », renommé à la fin.
 */
async function writeZipFile(target, entries, { onProgress, signal } = {}) {
  const part = `${target}.part`;
  const handle = await fs.promises.open(part, 'w');
  const centrals = [];
  let offset = 0;
  let last = 0;
  const write = async (buffer) => {
    await handle.write(buffer);
    offset += buffer.length;
  };
  try {
    onProgress?.({ done: 0, total: entries.length });
    for (let i = 0; i < entries.length; i++) {
      if (signal?.aborted) throw new Error(t('zip.sauvegarde_annulee'));
      const { name, path: file } = entries[i];
      const [data, stat] = await Promise.all([fs.promises.readFile(file), fs.promises.stat(file)]);
      if (data.length >= MAX32) throw new Error(t('zip.fichier_trop_gros', { name }));
      const compressed = await deflateRaw(data);
      const stored = compressed.length >= data.length;
      const body = stored ? data : compressed;
      const crc = zlib.crc32(data) >>> 0;
      const when = dosTime(stat.mtime);
      const nameBuffer = Buffer.from(name, 'utf8');

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(stored ? 0 : 8, 8);
      local.writeUInt16LE(when.time, 10);
      local.writeUInt16LE(when.date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuffer.length, 26);
      centrals.push({ nameBuffer, stored, when, crc, compressedSize: body.length, size: data.length, offset });
      await write(local);
      await write(nameBuffer);
      await write(body);
      if (i === entries.length - 1 || Date.now() - last > 100) {
        last = Date.now();
        onProgress?.({ done: i + 1, total: entries.length });
      }
    }

    const centralStart = offset;
    for (const c of centrals) {
      const far = c.offset >= MAX32;
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL, 0);
      header.writeUInt16LE(far ? 45 : 20, 4);
      header.writeUInt16LE(far ? 45 : 20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(c.stored ? 0 : 8, 10);
      header.writeUInt16LE(c.when.time, 12);
      header.writeUInt16LE(c.when.date, 14);
      header.writeUInt32LE(c.crc, 16);
      header.writeUInt32LE(c.compressedSize, 20);
      header.writeUInt32LE(c.size, 24);
      header.writeUInt16LE(c.nameBuffer.length, 28);
      header.writeUInt16LE(far ? 12 : 0, 30);
      header.writeUInt32LE(far ? MAX32 : c.offset, 42);
      await write(header);
      await write(c.nameBuffer);
      if (far) {
        const extra = Buffer.alloc(12);
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(8, 2);
        extra.writeBigUInt64LE(BigInt(c.offset), 4);
        await write(extra);
      }
    }
    const centralSize = offset - centralStart;
    const count = centrals.length;
    if (count >= 0xffff || centralStart >= MAX32 || centralSize >= MAX32) {
      const zip64At = offset;
      const record = Buffer.alloc(56);
      record.writeUInt32LE(ZIP64_EOCD, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE(45, 12);
      record.writeUInt16LE(45, 14);
      record.writeBigUInt64LE(BigInt(count), 24);
      record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(BigInt(centralSize), 40);
      record.writeBigUInt64LE(BigInt(centralStart), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(ZIP64_LOCATOR, 0);
      locator.writeBigUInt64LE(BigInt(zip64At), 8);
      locator.writeUInt32LE(1, 16);
      await write(record);
      await write(locator);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(EOCD, 0);
    end.writeUInt16LE(Math.min(count, 0xffff), 8);
    end.writeUInt16LE(Math.min(count, 0xffff), 10);
    end.writeUInt32LE(Math.min(centralSize, MAX32), 12);
    end.writeUInt32LE(Math.min(centralStart, MAX32), 16);
    await write(end);
    await handle.close();
    await fs.promises.rename(part, target);
    return { files: count, size: offset };
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.promises.rm(part, { force: true }).catch(() => {});
    throw error;
  }
}

/** Ouvre une archive sur disque : { entries, read(entry), close() }. Gère ZIP64 ; ne lit que ce qui est demandé. */
async function openZipFile(file) {
  const handle = await fs.promises.open(file, 'r');
  const readAt = async (position, length) => {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  };
  try {
    const { size } = await handle.stat();
    const tailStart = Math.max(0, size - 65557);
    const tail = await readAt(tailStart, size - tailStart);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error(t('zip.archive_zip_invalide'));
    let count = tail.readUInt16LE(eocd + 10);
    let centralSize = tail.readUInt32LE(eocd + 12);
    let centralStart = tail.readUInt32LE(eocd + 16);
    if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === ZIP64_LOCATOR) {
      const record = await readAt(Number(tail.readBigUInt64LE(eocd - 12)), 56);
      if (record.readUInt32LE(0) === ZIP64_EOCD) {
        count = Number(record.readBigUInt64LE(32));
        centralSize = Number(record.readBigUInt64LE(40));
        centralStart = Number(record.readBigUInt64LE(48));
      }
    }
    const central = await readAt(centralStart, centralSize);
    const entries = [];
    let at = 0;
    for (let n = 0; n < count && at + 46 <= central.length && central.readUInt32LE(at) === CENTRAL; n++) {
      const flags = central.readUInt16LE(at + 8);
      const nameLength = central.readUInt16LE(at + 28);
      const extraLength = central.readUInt16LE(at + 30);
      const commentLength = central.readUInt16LE(at + 32);
      const nameBytes = central.subarray(at + 46, at + 46 + nameLength);
      const entry = {
        name: nameBytes.toString(flags & 0x0800 ? 'utf8' : 'latin1'),
        method: central.readUInt16LE(at + 10),
        compressedSize: central.readUInt32LE(at + 20),
        size: central.readUInt32LE(at + 24),
        localOffset: central.readUInt32LE(at + 42),
      };
      // Champ ZIP64 : seules les valeurs saturées y figurent, dans cet ordre.
      let extra = at + 46 + nameLength;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const id = central.readUInt16LE(extra);
        const length = central.readUInt16LE(extra + 2);
        if (id === 0x0001) {
          let p = extra + 4;
          for (const key of ['size', 'compressedSize', 'localOffset']) {
            if (entry[key] === MAX32 && p + 8 <= extra + 4 + length) {
              entry[key] = Number(central.readBigUInt64LE(p));
              p += 8;
            }
          }
        }
        extra += 4 + length;
      }
      entries.push(entry);
      at = extraEnd + commentLength;
    }
    return {
      entries,
      async read(entry) {
        const local = await readAt(entry.localOffset, 30);
        if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(t('zip.archive_abimee', { name: entry.name }));
        const data = await readAt(entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28), entry.compressedSize);
        if (entry.method === 0) return data;
        if (entry.method === 8) return inflateRaw(data);
        throw new Error(t('zip.compression_zip_non_geree_pour', { method: entry.method, name: entry.name }));
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

module.exports = { listEntries, readEntry, readFile, createZip, writeZipFile, openZipFile };
