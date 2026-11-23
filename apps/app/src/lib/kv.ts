// Small JSON key-value store for settings and caches (native: one file per key in the documents dir).
import { Directory, File, Paths } from 'expo-file-system';

function dir(): Directory {
  const d = new Directory(Paths.document, 'qalm-kv');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

const safe = (key: string) => encodeURIComponent(key).replace(/%/g, '_');

export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    const f = new File(dir(), `${safe(key)}.json`);
    if (!f.exists) return undefined;
    return JSON.parse(await f.text()) as T;
  } catch {
    return undefined;
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const f = new File(dir(), `${safe(key)}.json`);
  if (value === undefined) {
    if (f.exists) f.delete();
    return;
  }
  if (!f.exists) f.create({ overwrite: true });
  f.write(JSON.stringify(value));
}
