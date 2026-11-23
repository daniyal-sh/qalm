// Web: <input type=file> through expo-document-picker; bytes from the File object.
// In Electron the preload's native open dialog is used instead (tech-spec §6).
import * as DocumentPicker from 'expo-document-picker';

import { desktop } from './desktop';
import { guessMime, type PickedFile } from './mime';

export type { PickedFile } from './mime';

export async function readUri(uri: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(uri)).arrayBuffer());
}

export async function pickFile(types: string[]): Promise<PickedFile | null> {
  const d = desktop();
  if (d) {
    const f = await d.openFile(types);
    if (!f) return null;
    const mime = f.mime || guessMime(f.name);
    const uri = URL.createObjectURL(new Blob([f.bytes as BlobPart], { type: mime }));
    return { name: f.name, mime, bytes: f.bytes, uri };
  }
  const r = await DocumentPicker.getDocumentAsync({ type: types, multiple: false });
  if (r.canceled || !r.assets[0]) return null;
  const a = r.assets[0];
  const bytes = a.file ? new Uint8Array(await a.file.arrayBuffer()) : await readUri(a.uri);
  return { name: a.name, mime: a.mimeType || guessMime(a.name), bytes, uri: a.uri };
}
