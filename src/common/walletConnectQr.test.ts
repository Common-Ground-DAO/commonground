// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Regression test for the WalletConnect QR code in RainbowKit's connect modal.
 *
 * RainbowKit 2.2.11 renders the QR with `cuer` (exact pin 0.0.3), which
 * depends on `qr: "~0"`. cuer 0.0.3 asks `qr` for a borderless matrix
 * (`border: 0`); qr ≥ 0.6 rejects that with `RangeError: invalid border=0`, and
 * the throw during render took the whole app down to its error page as soon as
 * "WalletConnect" was clicked. cuer 0.0.4 requests `border: 1` and slices the
 * ring off; the root `package.json` resolves RainbowKit's cuer to it.
 *
 * The modules are resolved *from RainbowKit's location*, so the test exercises
 * exactly the cuer/qr copies the bundle ships, not whatever a bare import
 * would find.
 */

const fromHere = createRequire(import.meta.url);
const fromRainbowKit = createRequire(fromHere.resolve('@rainbow-me/rainbowkit'));
const cuerEntry = fromRainbowKit.resolve('cuer');
const fromCuer = createRequire(cuerEntry);

type Grid = boolean[][];
type QrCodeModule = {
  create: (value: string, options?: { errorCorrection?: 'low' | 'medium' | 'quartile' | 'high' }) => {
    edgeLength: number;
    finderLength: number;
    grid: Grid;
  };
};

const loadCuer = async () => (await import(pathToFileURL(cuerEntry).href)) as { Cuer: any };
const loadQrCode = async () =>
  (await import(pathToFileURL(fromRainbowKit.resolve('cuer/QrCode')).href)) as QrCodeModule;
const loadDecode = async () =>
  (await import(pathToFileURL(fromCuer.resolve('qr/decode.js')).href)) as {
    decodeQR: (img: { width: number; height: number; data: Uint8Array }) => string;
  };

// A WalletConnect v2 pairing URI of the shape `@walletconnect/core` generates.
const WC_URI =
  'wc:7f6e504bfad60b485450578e05678ed3e8e8c4751d3c6160be17160d63ec90f9@2' +
  '?relay-protocol=irn' +
  '&symKey=587d5484ce2a2a6ee3ba1962fdd7e8588e06200c46823bd18fbd67def96ad303' +
  '&expiryTimestamp=1761919200' +
  '&methods=wc_sessionPropose%2Cwc_sessionAuthenticate';

/** Rasterise a module grid (dark = true) with a 4-module quiet zone as RGBA. */
function toImage(grid: Grid, scale = 4, quiet = 4) {
  const size = (grid.length + 2 * quiet) * scale;
  const data = new Uint8Array(size * size * 4).fill(255);
  grid.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }),
  );
  return { width: size, height: size, data };
}

describe('WalletConnect QR code (RainbowKit → cuer → qr)', () => {
  it('builds a borderless module matrix for a WalletConnect URI', async () => {
    const QrCode = await loadQrCode();
    const { grid, edgeLength, finderLength } = QrCode.create(WC_URI, { errorCorrection: 'medium' });

    // A QR symbol of version v is 17 + 4v modules wide.
    expect(edgeLength).toBe(grid.length);
    expect((edgeLength - 17) % 4).toBe(0);
    expect(edgeLength).toBeGreaterThanOrEqual(21);
    expect(edgeLength).toBeLessThanOrEqual(177);
    for (const row of grid) expect(row).toHaveLength(edgeLength);

    // Borderless: the top-left finder pattern starts at (0, 0) — a solid
    // 7-module ring around a light ring. A leftover quiet-zone ring would put
    // light modules on row/column 0.
    expect(finderLength).toBe(7);
    for (let i = 0; i < 7; i++) {
      expect(grid[0][i]).toBe(true);
      expect(grid[i][0]).toBe(true);
      expect(grid[6][i]).toBe(true);
      expect(grid[i][6]).toBe(true);
    }
    for (let i = 1; i < 6; i++) expect(grid[1][i]).toBe(false);
    // The separator after the finder is light.
    expect(grid[7][0]).toBe(false);
    expect(grid[0][7]).toBe(false);

    // The matrix decodes back to the URI.
    const { decodeQR } = await loadDecode();
    expect(decodeQR(toImage(grid))).toBe(WC_URI);
  });

  it('renders the Cuer tree RainbowKit uses for the connect modal without throwing', async () => {
    const { Cuer } = await loadCuer();
    // Mirrors RainbowKit 2.2.11's `QRCode` component (dist/index.js).
    const render = () =>
      renderToStaticMarkup(
        createElement(
          Cuer.Root,
          { errorCorrection: 'medium', size: 280, value: WC_URI },
          createElement(Cuer.Cells, { fill: 'currentColor', radius: 1 }),
          createElement(Cuer.Finder, { fill: 'currentColor', radius: 0.25 }),
        ),
      );
    expect(render).not.toThrow();
    const svg = render();
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain('<path');
  });
});
