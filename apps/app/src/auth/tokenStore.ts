// Native: tokens in the keychain / keystore.
import * as SecureStore from 'expo-secure-store';

import type { TokenStore, Tokens } from './tokens';

const KEY = 'qalm.tokens';

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
