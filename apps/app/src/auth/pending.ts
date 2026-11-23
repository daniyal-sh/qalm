/**
 * Email sign-in requests made on this device (tech-spec §4). Each asks the server to bind its link to
 * sha256(nonce); only this device knows the nonce, so a link that arrives without a matching entry here was
 * not requested on this device and must be confirmed by the user. Platform-free: storage and crypto are injected.
 */

export const PENDING_TTL_MS = 15 * 60 * 1000;

export interface Pending {
  nonce: string;
  expiresAt: number;
}

export type PendingMap = Record<string, Pending>;

export interface PendingDeps {
  load(): Promise<PendingMap | undefined>;
  save(v: PendingMap): Promise<void>;
  /** A fresh random nonce (≥128 bits). */
  random(): string;
  /** Lowercase hex sha256 of a string. */
  sha256(s: string): Promise<string>;
  now?: () => number;
}

const norm = (email: string) => email.trim().toLowerCase();

async function live(d: PendingDeps): Promise<PendingMap> {
  const t = (d.now ?? Date.now)();
  const out: PendingMap = {};
  for (const [k, v] of Object.entries((await d.load()) ?? {})) if (v && v.expiresAt > t) out[k] = v;
  return out;
}

/**
 * Starts (or renews) a request for `email` and returns the nonce hash to send to POST /auth/email/start.
 * A live request's nonce is reused, so every link sent in the last 15 minutes stays valid on this device.
 */
export async function beginEmailSignIn(d: PendingDeps, email: string): Promise<{ nonce: string; nonceHash: string }> {
  const map = await live(d);
  const key = norm(email);
  const nonce = map[key]?.nonce ?? d.random();
  map[key] = { nonce, expiresAt: (d.now ?? Date.now)() + PENDING_TTL_MS };
  await d.save(map);
  return { nonce, nonceHash: await d.sha256(nonce) };
}

/** The nonce of a live request for `email` made on this device, or null. */
export async function pendingNonce(d: PendingDeps, email: string): Promise<string | null> {
  return (await live(d))[norm(email)]?.nonce ?? null;
}

/** Forgets the request for `email` (after signing in), and any expired ones. */
export async function clearPending(d: PendingDeps, email: string): Promise<void> {
  const map = await live(d);
  delete map[norm(email)];
  await d.save(map);
}
