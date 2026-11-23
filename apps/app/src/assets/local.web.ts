// Web asset cache: blobs in IndexedDB, exposed as object URLs.
import { toHex } from '../lib/hex';

const DB = 'qalm-assets';
const STORE = 'blobs';
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export function extFor(mime: string): string {
  return mime === 'application/pdf' ? 'pdf' : (mime.split('/')[1] ?? 'bin');
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return toHex(new Uint8Array(buf));
}

const urls = new Map<string, string>();

export async function saveLocal(sha: string, mime: string, bytes: Uint8Array): Promise<void> {
  await run('readwrite', (s) => s.put(new Blob([bytes as BlobPart], { type: mime }), sha));
}

export async function readLocal(sha: string, _mime?: string): Promise<Uint8Array | null> {
  const b = await run<Blob | undefined>('readonly', (s) => s.get(sha) as IDBRequest<Blob | undefined>);
  return b ? new Uint8Array(await b.arrayBuffer()) : null;
}

export async function localUri(sha: string, _mime?: string): Promise<string | null> {
  const hit = urls.get(sha);
  if (hit) return hit;
  const b = await run<Blob | undefined>('readonly', (s) => s.get(sha) as IDBRequest<Blob | undefined>);
  if (!b) return null;
  const u = URL.createObjectURL(b);
  urls.set(sha, u);
  return u;
}
