// Native: pick files and read their bytes.
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';

import { guessMime, type PickedFile } from './mime';

export type { PickedFile } from './mime';

export async function readUri(uri: string): Promise<Uint8Array> {
  return new File(uri).bytes();
}

export async function pickFile(types: string[]): Promise<PickedFile | null> {
  const r = await DocumentPicker.getDocumentAsync({ type: types, copyToCacheDirectory: true, multiple: false });
  if (r.canceled || !r.assets[0]) return null;
  const a = r.assets[0];
  return { name: a.name, mime: a.mimeType ?? guessMime(a.name), bytes: await readUri(a.uri), uri: a.uri };
}
