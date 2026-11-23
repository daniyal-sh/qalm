import { Skia, type SkImage } from '@shopify/react-native-skia';

/** Native: Skia decodes the file (PDF page PNGs and images come from the app's cache directory). */
export async function decodeImage(uri: string): Promise<SkImage | null> {
  const data = await Skia.Data.fromURI(uri);
  return Skia.Image.MakeImageFromEncoded(data);
}
