// Native: tokens in the keychain / keystore.
import * as SecureStore from 'expo-secure-store';

import { config } from '../config';
import type { TokenStore, Tokens } from './tokens';
import { tokenKey } from './tokens';

// One sign-in per server, so a build pointed at another server never sends this one's tokens there.
// SecureStore keys allow only [A-Za-z0-9._-].
const KEY = tokenKey(config.serverUrl).replace(/[^A-Za-z0-9._-]/g, '_');

export const tokenStore: TokenStore = {
  async load() {
    try {
      const v = await SecureStore.getItemAsync(KEY);
      return v ? (JSON.parse(v) as Tokens) : null;
    } catch {
      return null;
    }
  },
  async save(t) {
    if (t) await SecureStore.setItemAsync(KEY, JSON.stringify(t));
    else await SecureStore.deleteItemAsync(KEY);
  },
};
