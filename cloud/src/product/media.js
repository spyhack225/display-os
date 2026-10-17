import { Buffer } from 'node:buffer';
import { inflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import crc from 'pngjs/lib/crc.js';
import filters from 'pngjs/lib/filter-parse-sync.js';
import bitmapper from 'pngjs/lib/bitmapper.js';
import encodePng from 'pngjs/lib/packer-sync.js';
import { reject, exact } from './common.js';

const MAX_BYTES = 98304;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048 || width * height > 4000000) reject(400, 'Choose a photo no larger than 2048 pixels per side and four million pixels.');
}

function pngPixels(bytes) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) reject(400, 'The photo does not match its format.');
  let offset = 8;
  let count = 0;
  let metadata;
  let ended = false;
  let imageEnded = false;
  const compressed = [];
  while (offset < bytes.length) {
    if (++count > 256 || offset + 12 > bytes.length) reject(400, 'This PNG is not supported.');
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) reject(400, 'This PNG is incomplete.');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) || bytes.readInt32BE(end - 4) !== crc.crc32(bytes.subarray(offset + 4, end - 4))) reject(400, 'This PNG is damaged.');
    const data = bytes.subarray(offset + 8, end - 4);
    if (count === 1 && type !== 'IHDR') reject(400, 'This PNG is not supported.');
    if (type === 'IHDR') {
      if (metadata || length !== 13) reject(400, 'This PNG is not supported.');
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      dimensions(width, height);
      const colorType = data[9];
      if (data[8] !== 8 || ![2, 6].includes(colorType) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) reject(400, 'Save this photo as a standard RGB or RGBA PNG, or as JPEG.');
      metadata = { width, height, depth: 8, bpp: colorType === 6 ? 4 : 3, interlace: false, colorType };
    } else if (type === 'IDAT') {
      if (!metadata || imageEnded) reject(400, 'This PNG is not supported.');
      compressed.push(data);
    } else if (type === 'IEND') {
      if (length || !compressed.length || end !== bytes.length) reject(400, 'This PNG is incomplete.');
      ended = true;
    } else {
      if (compressed.length) imageEnded = true;
      if (['acTL', 'fcTL', 'fdAT', 'tRNS'].includes(type) || (type[0] === type[0].toUpperCase() && type !== 'PLTE')) reject(400, 'This PNG format is not supported.');
      if (type === 'PLTE' && (compressed.length || metadata.colorType === 6 || !length || length > 768 || length % 3)) reject(400, 'This PNG is not supported.');
    }
    offset = end;
  }
  if (!ended || !metadata) reject(400, 'This PNG is incomplete.');
  const packed = Buffer.concat(compressed);
  const expected = (metadata.width * metadata.bpp + 1) * metadata.height;
  const decoded = inflateSync(packed, { maxOutputLength: expected, info: true });
  if (decoded.buffer.length !== expected || decoded.engine.bytesWritten !== packed.length) reject(400, 'This PNG contains invalid pixel data.');
  const unfiltered = filters.process(decoded.buffer, metadata);
  return { width: metadata.width, height: metadata.height, data: bitmapper.dataToBitMap(unfiltered, metadata) };
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) reject(400, 'The photo does not match its format.');
  let offset = 2;
  let markers = 0;
  let scans = 0;
  let size;
  while (offset < bytes.length) {
    if (++markers > 512 || bytes[offset++] !== 255) reject(400, 'This JPEG is not supported.');
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (offset !== bytes.length || !size || !scans) reject(400, 'This JPEG is incomplete.');
      return size;
    }
    if (!marker || marker === 0xd8 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > bytes.length) reject(400, 'This JPEG is not supported.');
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) reject(400, 'This JPEG is incomplete.');
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (![0xc0, 0xc2].includes(marker) || size || length < 8 || bytes[offset + 2] !== 8) reject(400, 'Save this photo as a standard JPEG.');
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      const components = bytes[offset + 7];
      if (![1, 3].includes(components) || length !== 8 + components * 3) reject(400, 'This JPEG color format is not supported.');
      dimensions(width, height);
      size = { width, height };
      let blocks = 0;
      for (let component = 0; component < components; component++) {
        const sampling = bytes[offset + 9 + component * 3];
        const horizontal = sampling >> 4;
        const vertical = sampling & 15;
        if (horizontal < 1 || horizontal > 4 || vertical < 1 || vertical > 4) reject(400, 'This JPEG is not supported.');
        blocks += horizontal * vertical;
      }
      if (blocks > 10) reject(400, 'This JPEG is not supported.');
    }
    offset += length;
    if (marker === 0xda) {
      if (!size || ++scans > 32) reject(400, 'This JPEG is not supported.');
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) { offset++; continue; }
        const start = offset;
        while (bytes[offset] === 255) offset++;
        const next = bytes[offset];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { offset++; continue; }
        offset = start;
        break;
      }
    }
  }
  reject(400, 'This JPEG is incomplete.');
}

export async function normalizeImage(input) {
  exact(input, ['data', 'mime']);
  if (!['image/png', 'image/jpeg'].includes(input.mime)) reject(415, 'Choose a JPEG or PNG photo.');
  if (typeof input.data !== 'string' || !input.data.length || input.data.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) reject(400, 'Choose a photo smaller than 96 KiB.');
  const bytes = Buffer.from(input.data, 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== input.data) reject(400, 'This photo is not supported.');
  let pixels;
  let encoded;
  try {
    if (input.mime === 'image/png') {
      pixels = pngPixels(bytes);
      encoded = encodePng({ data: pixels.data, width: pixels.width, height: pixels.height }, { colorType: 6, inputColorType: 6, bitDepth: 8, deflateLevel: 6 });
    } else {
      const size = jpegDimensions(bytes);
      pixels = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, tolerantDecoding: false, maxResolutionInMP: 4, maxMemoryUsageInMB: 64 });
      if (pixels.width !== size.width || pixels.height !== size.height) reject(400, 'This JPEG is not supported.');
      encoded = jpeg.encode({ data: pixels.data, width: pixels.width, height: pixels.height }, 80).data;
      for (let quality = 65; encoded.length > MAX_BYTES && quality >= 20; quality -= 15) {
        encoded = jpeg.encode({ data: pixels.data, width: pixels.width, height: pixels.height }, quality).data;
      }
    }
  } catch (error) {
    if (error?.status) throw error;
    reject(400, 'This photo is damaged or cannot be safely processed.');
  }
  if (!encoded.length || encoded.length > MAX_BYTES) reject(400, 'Please resize or compress this photo to fit 96 KiB.');
  return { data: Buffer.from(encoded).toString('base64'), mime: input.mime, width: pixels.width, height: pixels.height };
}
