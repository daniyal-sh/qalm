import { ImageFormat, Skia } from '@shopify/react-native-skia';

/** PNG bytes of an image PDF can't hold (WebP, GIF, HEIC, …), decoded with Skia; null if Skia can't read it. */
export async function toPng(bytes: Uint8Array): Promise<Uint8Array | null> {
  const img = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(bytes));
  if (!img) return null;
  try {
    return img.encodeToBytes(ImageFormat.PNG, 100);
  } finally {
    img.dispose?.();
  }
}
