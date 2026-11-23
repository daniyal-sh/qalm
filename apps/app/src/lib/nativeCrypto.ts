/**
 * Hermes (iOS / Android) has no Web Crypto. Install a secure `crypto.getRandomValues` and `crypto.randomUUID` from
 * expo-crypto before anything else runs, so code written for browsers (sign-in nonces in auth/device.ts, ids from
 * @qalm/core's newId) gets real randomness instead of throwing or falling back to Math.random.
 * Imported first by index.ts on native only; browsers, Electron and Workers have their own.
 */
import * as ExpoCrypto from 'expo-crypto';

type CryptoLike = { getRandomValues?: <T extends ArrayBufferView>(a: T) => T; randomUUID?: () => string };
const g = globalThis as { crypto?: CryptoLike };
const c: CryptoLike = g.crypto ?? (g.crypto = {});
if (typeof c.getRandomValues !== 'function') {
  c.getRandomValues = <T extends ArrayBufferView>(a: T): T => ExpoCrypto.getRandomValues(a as never) as T;
}
if (typeof c.randomUUID !== 'function') c.randomUUID = () => ExpoCrypto.randomUUID();
