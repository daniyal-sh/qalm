// Web: localStorage (per origin; Electron keeps it in the app's profile).
const PREFIX = 'qalm:';

export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    const v = globalThis.localStorage?.getItem(PREFIX + key);
    return v == null ? undefined : (JSON.parse(v) as T);
  } catch {
    return undefined;
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  try {
    if (value === undefined) globalThis.localStorage?.removeItem(PREFIX + key);
    else globalThis.localStorage?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage full or blocked */
  }
}
