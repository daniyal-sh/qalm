import type { SkImage } from '@shopify/react-native-skia';
import * as React from 'react';

import { decodeImage } from './decodeImage';
import { disposeLater } from './dispose';

/**
 * Loads an image for PageCanvas and frees it when the uri changes or the page unmounts (react-native-skia's
 * `useImage` never frees its images, which on web kept every PDF page bitmap in CanvasKit's heap). The previous
 * image stays until the next one is ready, so a zoom re-render never flashes blank.
 */
export function usePageImage(uri: string | undefined): SkImage | null {
  const [img, setImg] = React.useState<SkImage | null>(null);
  const cur = React.useRef<SkImage | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    if (!uri) return;
    let alive = true;
    decodeImage(uri)
      .then((next) => {
        if (!alive || !mounted.current) return disposeLater(next);
        disposeLater(cur.current);
        cur.current = next;
        setImg(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [uri]);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Not when React re-mounts right away (StrictMode): only if still unmounted after this task.
      setTimeout(() => {
        if (mounted.current) return;
        disposeLater(cur.current);
        cur.current = null;
      }, 0);
    };
  }, []);
  return img;
}
