// Native: write to the cache directory and open the share sheet.
import { File, FileMode, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export async function saveFile(name: string, mime: string, bytes: Uint8Array): Promise<void> {
  await saveFileStream(name, mime, async (out) => out(bytes));
}

/**
 * Like `saveFile`, for a file made in parts (a lecture export): each part is written to disk as it comes, so the
 * whole file is never in memory.
 */
export async function saveFileStream(name: string, mime: string, write: (out: (part: Uint8Array) => Promise<void>) => Promise<void>): Promise<void> {
  const f = new File(Paths.cache, name);
  if (f.exists) f.delete();
  f.create();
  const h = f.open(FileMode.WriteOnly);
  try {
    await write(async (part) => h.writeBytes(part));
  } finally {
    h.close();
  }
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(f.uri, {
      mimeType: mime,
      dialogTitle: name,
      UTI: mime === 'application/pdf' ? 'com.adobe.pdf' : undefined,
    });
  }
}
