/**
 * Runtime config from EXPO_PUBLIC_* env vars (Expo inlines these literal `process.env.X` reads at build time).
 * With no server URL the app runs fully offline: local docs only, no sign-in, no sync.
 */
export interface AppConfig {
  /** e.g. https://api.qalm.app (no trailing slash); undefined = offline-only build */
  serverUrl?: string;
  googleClientIds: { web?: string; ios?: string; android?: string };
}

export function normalizeBase(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const t = url.trim().replace(/\/+$/, '');
  return t || undefined;
}

const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

export const config: AppConfig = {
  serverUrl: normalizeBase(process.env.EXPO_PUBLIC_QALM_SERVER_URL),
  googleClientIds: {
    web: blank(process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID),
    ios: blank(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID),
    android: blank(process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID),
  },
};

/** ws(s):// base for the sync socket. */
export function wsBase(httpBase: string): string {
  return httpBase.replace(/^http(s?):\/\//, (_m, s: string) => `ws${s}://`);
}
