/**
 * Minimal valid PNG generator for upload fixtures — no image dependency.
 * Produces an 8-bit RGBA PNG of a solid color; sharp on the server side
 * happily decodes and re-encodes it to WebP.
 */

import { deflateSync, crc32 } from "node:zlib";

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

export function makePng(
  width: number,
  height: number,
  rgba: [number, number, number, number] = [200, 40, 40, 255],
): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // compression/filter/interlace stay 0

  const stride = width * 4 + 1; // +1 filter byte per scanline
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw.set(rgba, row + 1 + x * 4);
    }
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
