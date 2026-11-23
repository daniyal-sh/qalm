// Web / Electron: no keychain in the browser; localStorage on the app's own origin.
import type { TokenStore, Tokens } from './tokens';

const KEY = 'qalm:tokens';

export const tokenStore: TokenStore = {
  async load() {
    try {
      const v = globalThis.localStorage?.getItem(KEY);
      return v ? (JSON.parse(v) as Tokens) : null;
    } catch {
      return null;
    }
  },
  async save(t) {
    try {
      if (t) globalThis.localStorage?.setItem(KEY, JSON.stringify(t));
      else globalThis.localStorage?.removeItem(KEY);
    } catch {
      /* blocked storage */
    }
  },
};
