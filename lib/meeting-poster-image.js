'use strict';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_POSTER_BYTES = 32 * 1024 * 1024;
const BASE_WIDTH = 1080;
const MAX_LOGICAL_HEIGHT = 6000;
const MAX_SCALE = 3;
const MAX_PIXEL_COUNT = 32 * 1024 * 1024;

function readPngDimensions(png) {
  if (!Buffer.isBuffer(png) || png.length < 24 || png.length > MAX_POSTER_BYTES ||
      !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.readUInt32BE(8) !== 13 ||
      png.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('图片数据无效');
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || !height || width > BASE_WIDTH * MAX_SCALE || height > MAX_LOGICAL_HEIGHT * MAX_SCALE || width * height > MAX_PIXEL_COUNT) {
    throw new Error('图片数据无效或尺寸超出上限');
  }
  return { width, height };
}

function getLogicalHeight({ width, height }) {
  const scale = width / BASE_WIDTH;
  if (scale < 1 || scale > MAX_SCALE) {
    throw new Error('图片数据无效或尺寸超出上限');
  }
  const logicalHeight = Math.round(height / scale);
  if (logicalHeight < 1 || logicalHeight > MAX_LOGICAL_HEIGHT) throw new Error('图片数据无效或尺寸超出上限');
  return logicalHeight;
}

function normalizePosterPng(png, nativeImage, expectedHeight) {
  const dimensions = readPngDimensions(png);
  const logicalHeight = getLogicalHeight(dimensions);
  if (expectedHeight !== undefined && logicalHeight !== expectedHeight) throw new Error('图片数据无效或尺寸超出上限');
  if (dimensions.width === BASE_WIDTH && dimensions.height === logicalHeight) return png;
  let image;
  try { image = nativeImage.createFromBuffer(png); } catch { throw new Error('图片数据无效'); }
  if (!image || image.isEmpty()) throw new Error('图片数据无效');
  let normalized;
  try { normalized = image.resize({ width: BASE_WIDTH, height: logicalHeight, quality: 'best' }).toPNG(); }
  catch { throw new Error('图片数据无法规范化'); }
  const result = readPngDimensions(normalized);
  if (result.width !== BASE_WIDTH || result.height !== logicalHeight) throw new Error('图片数据无法规范化');
  return normalized;
}

function decodePosterDataUrl(dataUrl) {
  const prefix = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || dataUrl.length > prefix.length + Math.ceil(MAX_POSTER_BYTES / 3) * 4 ||
      !dataUrl.startsWith(prefix) || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataUrl.slice(prefix.length))) {
    throw new Error('图片数据无效或超过大小上限');
  }
  const encoded = dataUrl.slice(prefix.length);
  const png = Buffer.from(encoded, 'base64');
  if (png.length > MAX_POSTER_BYTES || png.toString('base64') !== encoded) throw new Error('图片数据无效或超过大小上限');
  return png;
}

module.exports = { MAX_POSTER_BYTES, readPngDimensions, normalizePosterPng, decodePosterDataUrl };
