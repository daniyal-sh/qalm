/** PNG bytes of an image PDF can't hold (WebP, GIF, …), decoded by the browser; null if it can't read it. */
export async function toPng(bytes: Uint8Array): Promise<Uint8Array | null> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
  try {
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } finally {
    bmp.close();
  }
}
