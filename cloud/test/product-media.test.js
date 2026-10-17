import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import crc from 'pngjs/lib/crc.js';
import { normalizeImage } from '../src/product/media.js';

function chunk(type, data = Buffer.alloc(0)) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const checksum = Buffer.alloc(4); checksum.writeInt32BE(crc.crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function png(width = 2, height = 2) {
  const data = Buffer.alloc(width * height * 4, 220);
  return PNG.sync.write({ width, height, data });
}

function image(bytes, mime = 'image/png') { return { data: bytes.toString('base64'), mime }; }

test('PNG fully decodes and re-encodes the same pixels without ancillary metadata', async () => {
  const original = png();
  const withMetadata = Buffer.concat([original.subarray(0, 33), chunk('tEXt', Buffer.from('Location\0Private address')), original.subarray(33)]);
  const result = await normalizeImage(image(withMetadata));
  const normalized = Buffer.from(result.data, 'base64');
  assert.deepEqual({ width: result.width, height: result.height, mime: result.mime }, { width: 2, height: 2, mime: 'image/png' });
  assert.equal(normalized.includes(Buffer.from('Private address')), false);
  assert.equal(normalized.includes(Buffer.from('tEXt')), false);
  assert.deepEqual(PNG.sync.read(normalized).data, PNG.sync.read(original).data);
});

test('JPEG fully decodes and re-encodes without EXIF, comments or hidden trailing data', async () => {
  const raw = { width: 8, height: 8, data: Buffer.alloc(8 * 8 * 4, 220) };
  const bytes = jpeg.encode(raw, 80).data;
  const exif = Buffer.from('Exif\0\0private-coordinate');
  const length = Buffer.alloc(2); length.writeUInt16BE(exif.length + 2);
  const withExif = Buffer.concat([bytes.subarray(0, 2), Buffer.from([255, 225]), length, exif, bytes.subarray(2)]);
  const result = await normalizeImage(image(withExif, 'image/jpeg'));
  const output = Buffer.from(result.data, 'base64');
  assert.equal(output.includes(Buffer.from('private-coordinate')), false);
  assert.equal(output.includes(Buffer.from('Exif')), false);
  assert.equal(jpeg.decode(output).width, 8);
  await assert.rejects(normalizeImage(image(Buffer.concat([bytes, Buffer.from('<script>bad</script>')]), 'image/jpeg')));
});

test('MIME mismatches, unknown fields, invalid base64 and unsupported image types fail closed', async () => {
  const cases = [image(png(), 'image/jpeg'), { ...image(png()), extra: true }, image(Buffer.from('<svg/>'), 'image/svg+xml'), { data: 'data:image/png;base64,' + png().toString('base64'), mime: 'image/png' }, { data: 'a===', mime: 'image/png' }, { data: 'AB==', mime: 'image/png' }, { data: '', mime: 'image/png' }, { data: 'A'.repeat(131076), mime: 'image/png' }];
  for (const value of cases) await assert.rejects(normalizeImage(value));
});

test('a valid compressed JPEG stays inside the photo limit after sanitizing', async () => {
  const width = 640;
  const height = 426;
  const data = Buffer.alloc(width * height * 4);
  let seed = 123456;
  for (let index = 0; index < data.length; index += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[index] = seed & 255; data[index + 1] = (seed >>> 8) & 255; data[index + 2] = (seed >>> 16) & 255; data[index + 3] = 255;
  }
  const compressed = jpeg.encode({ width, height, data }, 15).data;
  assert.ok(compressed.length <= 98304);
  const result = await normalizeImage(image(compressed, 'image/jpeg'));
  assert.ok(Buffer.from(result.data, 'base64').length <= 98304);
  assert.equal(result.width, width);
  assert.equal(result.height, height);
  assert.equal(jpeg.decode(Buffer.from(result.data, 'base64')).width, width);
});

test('PNG CRC, truncation, duplicate headers, animation and unsupported interlace fail', async () => {
  const original = png();
  const damaged = Buffer.from(original); damaged[20] ^= 1;
  const header = Buffer.from(original.subarray(16, 29)); header[12] = 1;
  const interlaced = Buffer.concat([original.subarray(0, 8), chunk('IHDR', header), original.subarray(33)]);
  for (const bytes of [damaged, original.subarray(0, original.length - 1), Buffer.concat([original.subarray(0, 33), original.subarray(8, 33), original.subarray(33)]), Buffer.concat([original.subarray(0, 33), chunk('acTL', Buffer.alloc(8)), original.subarray(33)]), interlaced, Buffer.concat([original, Buffer.from('hidden')])]) await assert.rejects(normalizeImage(image(bytes)));
});

test('dimensions and PNG compressed expansion are checked before bitmap allocation', async () => {
  const original = png();
  for (const [width, height] of [[2049, 1], [2001, 2000], [0, 2]]) {
    const header = Buffer.from(original.subarray(16, 29)); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
    await assert.rejects(normalizeImage(image(Buffer.concat([original.subarray(0, 8), chunk('IHDR', header), original.subarray(33)]))));
  }
  const bomb = Buffer.concat([original.subarray(0, 33), chunk('IDAT', deflateSync(Buffer.alloc(1024 * 1024))), chunk('IEND')]);
  await assert.rejects(normalizeImage(image(bomb)), /safely processed/);
  const extraStream = Buffer.concat([original.subarray(0, 33), chunk('IDAT', Buffer.concat([deflateSync(Buffer.alloc(18)), Buffer.from('private payload')])), chunk('IEND')]);
  await assert.rejects(normalizeImage(image(extraStream)));
});

test('header-only JPEG, damaged entropy and oversized JPEG frame fail without accepting a header', async () => {
  await assert.rejects(normalizeImage(image(Buffer.from([255, 216, 255, 217]), 'image/jpeg')));
  const original = jpeg.encode({ width: 8, height: 8, data: Buffer.alloc(256, 255) }, 80).data;
  const offset = original.indexOf(Buffer.from([255, 192]));
  const oversized = Buffer.from(original); oversized.writeUInt16BE(2049, offset + 7);
  await assert.rejects(normalizeImage(image(oversized, 'image/jpeg')));
  await assert.rejects(normalizeImage(image(original.subarray(0, original.length - 8), 'image/jpeg')));
});
