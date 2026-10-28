'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_POSTER_BYTES, readPngDimensions, normalizePosterPng, decodePosterDataUrl } = require('../lib/meeting-poster-image');

function pngHeader(width, height) {
  const png = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(width, 16); png.writeUInt32BE(height, 20);
  png[24] = 8; png[25] = 2; png[26] = 0; png[27] = 0; png[28] = 0;
  png.writeUInt32BE(0, 29);
  return png;
}

test('accepts PNG headers inside the bounded 1x to 3x pixel envelope', () => {
  assert.deepEqual(readPngDimensions(pngHeader(1080, 6000)), { width: 1080, height: 6000 });
  assert.deepEqual(readPngDimensions(pngHeader(2160, 12000)), { width: 2160, height: 12000 });
  assert.deepEqual(readPngDimensions(pngHeader(1350, 1251)), { width: 1350, height: 1251 });
  assert.deepEqual(readPngDimensions(pngHeader(1620, 1502)), { width: 1620, height: 1502 });
  assert.throws(() => readPngDimensions(pngHeader(4320, 24000)), /尺寸超出上限/);
});

test('normalizes fractional-DPI legacy PNGs using their rounded logical height', () => {
  const source = pngHeader(1620, 1502); // 1.5x capture of a 1001 DIP tall page
  let resizedTo;
  const nativeImage = { createFromBuffer: () => ({ isEmpty: () => false, resize: options => {
    resizedTo = options;
    return { toPNG: () => pngHeader(options.width, options.height) };
  } }) };
  const normalized = normalizePosterPng(source, nativeImage, 1001);
  assert.deepEqual(resizedTo, { width: 1080, height: 1001, quality: 'best' });
  assert.deepEqual(readPngDimensions(normalized), { width: 1080, height: 1001 });
});

test('data URL parser enforces canonical base64 and the 32 MiB input limit', () => {
  const png = pngHeader(1080, 100);
  assert.deepEqual(decodePosterDataUrl(`data:image/png;base64,${png.toString('base64')}`), png);
  assert.throws(() => decodePosterDataUrl('data:image/png;base64,%%%'), /无效/);
  assert.throws(() => decodePosterDataUrl(`data:image/png;base64,${'A'.repeat(Math.ceil(MAX_POSTER_BYTES / 3) * 4 + 4)}`), /大小上限/);
});
