import { Skia, type SkImage } from '@shopify/react-native-skia';

/**
 * Web: the browser decodes off the main thread (createImageBitmap) and CanvasKit uploads the bitmap as a texture,
 * instead of decoding the PNG synchronously into CanvasKit's WASM heap.
 */
export async function decodeImage(uri: string): Promise<SkImage | null> {
  const blob = await (await fetch(uri)).blob();
  const bitmap = await createImageBitmap(blob);
  return Skia.Image.MakeImageFromNativeBuffer(bitmap);
}
