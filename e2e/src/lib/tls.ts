// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import tls from 'node:tls';

/**
 * Trust for an instance whose certificate comes from a private CA (self-host
 * with CG_TLS_MODE=internal, the disposable e2e instance).
 *
 * Chrome for Testing has no flag to add a root CA, and importing one needs
 * NSS tools the runner image does not have. Instead the suite verifies the
 * chain each port presents against the given CA file itself (node:tls, full
 * verification incl. the host name) and then pins only the public key of
 * each verified *leaf* certificate with --ignore-certificate-errors-spki-list.
 * Chrome accepts a chain containing a pinned key despite errors, so pinning
 * the intermediate or root would let any server presenting that (public)
 * intermediate pass for any host; a leaf key belongs to this instance only.
 *
 * Caddy renews internal leaf certificates (with a new key) well before they
 * expire; a renewal during the run would invalidate the pin, so the run is
 * refused when a leaf has less than MIN_REMAINING_MS left, and a warning is
 * printed below WARN_REMAINING_MS.
 */

const MIN_REMAINING_MS = 20 * 60 * 1000;
const WARN_REMAINING_MS = 60 * 60 * 1000;

export async function spkiPinsFor(baseUrl: string, caFile: string | undefined, extraPorts: number[]): Promise<{ pins: string[]; details: string[] }> {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:') {
    return { pins: [], details: ['plain HTTP target: no TLS pinning'] };
  }
  const ca = caFile ? readFileSync(caFile, 'utf8') : undefined;
  const ports = [Number(url.port || 443), ...extraPorts];
  const pins = new Set<string>();
  const details: string[] = [];
  for (const port of ports) {
    let leaf: X509Certificate;
    try {
      leaf = await fetchVerifiedLeaf(url.hostname, port, ca);
    }
    catch (e) {
      if (port !== ports[0]) {
        // optional port (call signalling): the instance may not serve it
        details.push(`${url.hostname}:${port}: ${(e as Error).message} (ignored)`);
        continue;
      }
      throw new Error(`TLS check of ${url.hostname}:${port} failed: ${(e as Error).message}` +
        (ca ? '' : ' — for a self-host instance with a private CA pass --ca <root.crt>'));
    }
    const remaining = Date.parse(leaf.validTo) - Date.now();
    if (ca && remaining < MIN_REMAINING_MS) {
      throw new Error(`the certificate of ${url.hostname}:${port} expires in ${Math.round(remaining / 60_000)} min; ` +
        'its renewal (new key) during the run would break the pin — wait for the renewal and start again');
    }
    if (ca && remaining < WARN_REMAINING_MS) {
      details.push(`WARNING: ${url.hostname}:${port} certificate expires in ${Math.round(remaining / 60_000)} min — a renewal during the run breaks the pin`);
    }
    const der = leaf.publicKey.export({ type: 'spki', format: 'der' });
    const pin = createHash('sha256').update(der).digest('base64');
    if (!pins.has(pin)) {
      pins.add(pin);
      details.push(`${url.hostname}:${port}: leaf ${(leaf.subjectAltName || leaf.subject || '?').replace(/\n/g, ', ')}, valid until ${leaf.validTo} — ${ca ? `pinned ${pin}` : 'publicly trusted, not pinned'}`);
    }
  }
  // a publicly trusted certificate needs no pins
  return { pins: ca ? [...pins] : [], details };
}

function fetchVerifiedLeaf(host: string, port: number, ca: string | undefined): Promise<X509Certificate> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, ca, rejectUnauthorized: true, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate(false);
      socket.end();
      if (!cert?.raw) {
        reject(new Error('no certificate presented'));
        return;
      }
      resolve(new X509Certificate(cert.raw));
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('timeout'));
    });
    socket.on('error', reject);
  });
}
