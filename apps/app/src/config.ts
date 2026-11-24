/**
 * Runtime config from EXPO_PUBLIC_* env vars (Expo inlines these literal `process.env.X` reads at build time).
 * With no server URL the app runs fully offline: local docs only, no sign-in, no sync.
 */
export interface AppConfig {
  /** e.g. https://api.qalm.app (no trailing slash); undefined = offline-only build */
  serverUrl?: string;
}

export function normalizeBase(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const t = url.trim().replace(/\/+$/, '');
  return t || undefined;
}

export const config: AppConfig = {
  serverUrl: normalizeBase(process.env.EXPO_PUBLIC_QALM_SERVER_URL),
};

/** ws(s):// base for the sync socket. */
export function wsBase(httpBase: string): string {
  return httpBase.replace(/^http(s?):\/\//, (_m, s: string) => `ws${s}://`);
}
