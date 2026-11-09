'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const nbt = require('../src/main/core/nbt');

// Petit écrivain NBT (big-endian) pour fabriquer un level.dat de test.
const u8 = (n) => Buffer.from([n & 0xff]);
const i16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64BE(n); return b; };
const f64 = (n) => { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b; };
const str = (s) => { const data = Buffer.from(s, 'utf8'); return Buffer.concat([i16(data.length), data]); };
const tag = (type, name, payload) => Buffer.concat([u8(type), str(name), payload]);
const compound = (...tags) => Buffer.concat([...tags, u8(0)]);

const DATA = compound(
  tag(8, 'LevelName', str('Mundo 2')),
  tag(3, 'DataVersion', i32(4189)),
  tag(4, 'LastPlayed', i64(1762700000000n)),
  tag(1, 'hardcore', u8(1)),
  tag(6, 'BorderSize', f64(59999968)),
  tag(10, 'Version', compound(tag(8, 'Name', str('1.21.4')), tag(1, 'Snapshot', u8(0)))),
  tag(9, 'ServerBrands', Buffer.concat([u8(8), i32(2), str('vanilla'), str('fabric')])),
  tag(11, 'Ids', Buffer.concat([i32(2), i32(1), i32(2)])),
  tag(7, 'Octets', Buffer.concat([i32(3), Buffer.from([1, 2, 3])])),
);
const LEVEL = Buffer.concat([u8(10), str(''), compound(tag(10, 'Data', DATA))]);

test('parse : level.dat compressé (gzip) et non compressé', () => {
  for (const buffer of [zlib.gzipSync(LEVEL), LEVEL]) {
    const data = nbt.get(nbt.parse(buffer), 'Data');
    assert.equal(nbt.get(data, 'LevelName'), 'Mundo 2');
    assert.equal(nbt.get(data, 'DataVersion'), 4189);
    assert.equal(nbt.get(data, 'LastPlayed'), 1762700000000n);
    assert.equal(nbt.get(data, 'hardcore'), 1);
    assert.equal(nbt.get(data, 'BorderSize'), 59999968);
    assert.equal(nbt.get(nbt.get(data, 'Version'), 'Name'), '1.21.4');
    assert.deepEqual(nbt.get(data, 'ServerBrands'), ['vanilla', 'fabric']);
    assert.equal(nbt.get(data, 'Ids'), null);
    assert.deepEqual([...nbt.get(data, 'Octets')], [1, 2, 3]);
  }
});

test('get : entrée absente ou compound invalide', () => {
  const root = nbt.parse(LEVEL);
  assert.equal(nbt.get(root, 'Absent'), undefined);
  assert.equal(nbt.get(null, 'Data'), undefined);
});

test('parse : fichiers abîmés refusés', () => {
  assert.throws(() => nbt.parse(LEVEL.subarray(0, LEVEL.length - 10)), /truncated/);
  assert.throws(() => nbt.parse(Buffer.concat([u8(8), str(''), str('x')])), /root/);
  assert.throws(() => nbt.parse(Buffer.concat([u8(10), str(''), tag(99, 'x', Buffer.alloc(0))])), /type/);
  // Longueur de tableau négative.
  assert.throws(() => nbt.parse(Buffer.concat([u8(10), str(''), tag(7, 'x', i32(-1)), u8(0)])));
});

test('parse : imbrication trop profonde refusée', () => {
  let deep = u8(0);
  for (let i = 0; i < 600; i++) deep = Buffer.concat([tag(10, 'x', deep), u8(0)]);
  assert.throws(() => nbt.parse(Buffer.concat([u8(10), str(''), deep])), /deep/);
});
