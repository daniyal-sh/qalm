/** Access/refresh token handling (tech-spec §4: access JWT 1 h, POST /auth/refresh renews). Platform-free. */

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface TokenStore {
  load(): Promise<Tokens | null>;
  save(t: Tokens | null): Promise<void>;
}

export interface User {
  id: string;
  email?: string;
  name?: string;
}

export class AuthError extends Error {}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function b64urlDecode(s: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bytes: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const c of clean) {
    const v = chars.indexOf(c);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 0xff);
    }
  }
  // UTF-8 decode
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[++i]! & 0x3f));
    else if (b < 0xf0)
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[++i]! & 0x3f) << 6) | (bytes[++i]! & 0x3f));
    else {
      const cp = ((b & 0x07) << 18) | ((bytes[++i]! & 0x3f) << 12) | ((bytes[++i]! & 0x3f) << 6) | (bytes[++i]! & 0x3f);
      out += String.fromCodePoint(cp);
    }
  }
  return out;
}

export interface JwtClaims {
  sub?: string;
  exp?: number;
  email?: string;
  name?: string;
}

export function decodeJwt(token: string): JwtClaims {
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    return JSON.parse(b64urlDecode(part)) as JwtClaims;
  } catch {
    return {};
  }
}

/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * Keeps the session's tokens, refreshes them single-flight before expiry or after a 401,
 * and signs out when the refresh token is rejected.
 */
export class TokenManager {
  private tokens: Tokens | null = null;
  private refreshing: Promise<Tokens> | null = null;
  private listeners = new Set<(u: User | null) => void>();

  constructor(
    private readonly baseUrl: string,
    private readonly store: TokenStore,
    private readonly fetchFn: FetchFn = (i, init) => fetch(i, init),
    private readonly now: () => number = () => Date.now(),
  ) {}

  async load(): Promise<User | null> {
    this.tokens = await this.store.load();
    return this.user();
  }

  user(): User | null {
    if (!this.tokens) return null;
    const c = decodeJwt(this.tokens.accessToken);
    if (!c.sub) return null;
    return { id: c.sub, email: c.email, name: c.name };
  }

  onChange(cb: (u: User | null) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit(): void {
    const u = this.user();
    for (const l of [...this.listeners]) l(u);
  }

  async setTokens(t: Tokens | null): Promise<void> {
    this.tokens = t;
    await this.store.save(t);
    this.emit();
  }

  signOut(): Promise<void> {
    return this.setTokens(null);
  }

  private expiresSoon(t: Tokens): boolean {
    const exp = decodeJwt(t.accessToken).exp;
    return typeof exp === 'number' && exp * 1000 - this.now() < REFRESH_MARGIN_MS;
  }

  /** A valid access token, refreshing first if needed. Throws AuthError when signed out. */
  async accessToken(): Promise<string> {
    const t = this.tokens;
    if (!t) throw new AuthError('signed out');
    if (!this.expiresSoon(t)) return t.accessToken;
    return (await this.refresh()).accessToken;
  }

  refresh(): Promise<Tokens> {
    this.refreshing ??= (async () => {
      try {
        const t = this.tokens;
        if (!t) throw new AuthError('signed out');
        let res: Response;
        try {
          res = await this.fetchFn(`${this.baseUrl}/auth/refresh`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ refreshToken: t.refreshToken }),
          });
        } catch (e) {
          // Network error: keep the session, the caller retries later.
          throw e instanceof Error ? e : new Error(String(e));
        }
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          await this.signOut();
          throw new AuthError('session expired');
        }
        if (!res.ok) throw new Error(`refresh ${res.status}`);
        const next = (await res.json()) as Tokens;
        await this.setTokens({ accessToken: next.accessToken, refreshToken: next.refreshToken ?? t.refreshToken });
        return this.tokens!;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** fetch against the server with Bearer auth; refreshes once and retries on 401. */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const send = (token: string) => {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${token}`);
      return this.fetchFn(`${this.baseUrl}${path}`, { ...init, headers });
    };
    const res = await send(await this.accessToken());
    if (res.status !== 401) return res;
    const t = await this.refresh();
    return send(t.accessToken);
  }

  /** Unauthenticated JSON POST (sign-in endpoints). Stores the returned tokens. */
  async signIn(path: string, body: unknown): Promise<User> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new AuthError(`sign-in failed (${res.status})`);
    const t = (await res.json()) as Tokens;
    if (!t.accessToken || !t.refreshToken) throw new AuthError('sign-in returned no tokens');
    await this.setTokens(t);
    const u = this.user();
    if (!u) throw new AuthError('token has no subject');
    return u;
  }
}
