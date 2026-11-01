// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

/**
 * Test images without fixtures or dependencies: a PNG encoder for a simple
 * colour gradient (harmless for the server-side image filter).
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

/** an RGB PNG of a two-colour gradient with a light grid */
export function gradientPng(width: number, height: number, from: [number, number, number], to: [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const f = (x + y) / (width + height);
      const grid = (x % 16 === 0 || y % 16 === 0) ? 40 : 0;
      for (let ch = 0; ch < 3; ch++) {
        raw[row + 1 + x * 3 + ch] = Math.min(255, Math.round(from[ch] + (to[ch] - from[ch]) * f) + grid);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** writes a test PNG into `dir` and returns its path */
export function writeTestPng(dir: string, name: string, width = 256, height = 256, seed = 0): string {
  mkdirSync(dir, { recursive: true });
  const palette: [number, number, number][] = [[40, 90, 200], [230, 120, 40], [30, 160, 90], [150, 60, 180]];
  const path = `${dir}/${name}.png`;
  writeFileSync(path, gradientPng(width, height, palette[seed % 4], palette[(seed + 1) % 4]));
  return path;
}
