/**
 * Minimal cookie jar for a single origin.
 *
 * The server uses plain `Set-Cookie` session cookies (see contract:
 * docs/api — auth/session). A browser brings its own jar; a headless client
 * needs this one. Scope handling is deliberately simple: the SDK talks to
 * exactly one instance origin, so cookies are keyed by name only and sent on
 * every request to that origin. Path/domain attributes are ignored on
 * purpose; expiry and deletion (Max-Age=0 / past Expires) are honored.
 */

interface StoredCookie {
  value: string;
  /** epoch ms; undefined = session cookie (lives as long as the jar) */
  expiresAt?: number;
}

export class CookieJar {
  private cookies = new Map<string, StoredCookie>();

  storeFrom(setCookieHeaders: string[]): void {
    for (const header of setCookieHeaders) {
      const [pair, ...attrs] = header.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let expiresAt: number | undefined;
      for (const attr of attrs) {
        const [k, v] = attr.split("=").map((s) => s.trim());
        const key = k.toLowerCase();
        if (key === "max-age" && v !== undefined) {
          const seconds = Number(v);
          if (Number.isFinite(seconds)) expiresAt = Date.now() + seconds * 1000;
        } else if (key === "expires" && v !== undefined && expiresAt === undefined) {
          const t = Date.parse(attrs.find((a) => a.trim().toLowerCase().startsWith("expires="))!.trim().slice("expires=".length));
          if (Number.isFinite(t)) expiresAt = t;
        }
      }
      if (expiresAt !== undefined && expiresAt <= Date.now()) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, { value, expiresAt });
      }
    }
  }

  /** `Cookie:` header value for a request, or undefined if the jar is empty. */
  cookieHeader(): string | undefined {
    const now = Date.now();
    const parts: string[] = [];
    for (const [name, c] of this.cookies) {
      if (c.expiresAt !== undefined && c.expiresAt <= now) {
        this.cookies.delete(name);
        continue;
      }
      parts.push(`${name}=${c.value}`);
    }
    return parts.length ? parts.join("; ") : undefined;
  }

  get(name: string): string | undefined {
    const c = this.cookies.get(name);
    if (!c) return undefined;
    if (c.expiresAt !== undefined && c.expiresAt <= Date.now()) {
      this.cookies.delete(name);
      return undefined;
    }
    return c.value;
  }

  clear(): void {
    this.cookies.clear();
  }
}
