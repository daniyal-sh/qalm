// This device's pending email sign-in requests, stored in the app's key-value store.
import { sha256 } from '../assets/local';
import { kvGet, kvSet } from '../lib/kv';
import type { PendingDeps, PendingMap } from './pending';

function randomHex(bytes = 32): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export const pendingDeps: PendingDeps = {
  load: () => kvGet<PendingMap>('auth:pending'),
  save: (v) => kvSet('auth:pending', v),
  random: () => randomHex(),
  sha256: (s) => sha256(new TextEncoder().encode(s)),
};
