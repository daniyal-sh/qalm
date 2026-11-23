// Native: write to the cache directory and open the share sheet.
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export async function saveFile(name: string, mime: string, bytes: Uint8Array): Promise<void> {
  const f = new File(Paths.cache, name);
  if (f.exists) f.delete();
  f.create();
  f.write(bytes);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(f.uri, {
      mimeType: mime,
      dialogTitle: name,
      UTI: mime === 'application/pdf' ? 'com.adobe.pdf' : undefined,
    });
  }
}
