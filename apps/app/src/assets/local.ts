// Native asset cache: content-addressed files in the documents directory.
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

import { toHex } from '../lib/hex';

function dir(): Directory {
  const d = new Directory(Paths.document, 'qalm-assets');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

export function extFor(mime: string): string {
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  // Lecture audio chunks (docs/lecture-mode.md §1).
  if (mime.startsWith('audio/mp4')) return 'm4a';
  // ADTS (the native recorder's crash-safe format): players go by the extension, so it must not claim to be M4A.
  if (mime.startsWith('audio/aac')) return 'aac';
  if (mime.startsWith('audio/webm')) return 'webm';
  return 'bin';
}

const fileFor = (sha: string, mime: string) => new File(dir(), `${sha}.${extFor(mime)}`);

export async function sha256(bytes: Uint8Array): Promise<string> {
  const buf = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes as unknown as BufferSource);
  return toHex(new Uint8Array(buf));
}

export async function saveLocal(sha: string, mime: string, bytes: Uint8Array): Promise<void> {
  const f = fileFor(sha, mime);
  if (f.exists) return;
  f.create({ overwrite: true });
  f.write(bytes);
}

export async function readLocal(sha: string, mime: string): Promise<Uint8Array | null> {
  const f = fileFor(sha, mime);
  return f.exists ? await f.bytes() : null;
}

/** A file:// uri for Skia images and QalmInk.renderPdfPage. */
export async function localUri(sha: string, mime: string): Promise<string | null> {
  const f = fileFor(sha, mime);
  return f.exists ? f.uri : null;
}
