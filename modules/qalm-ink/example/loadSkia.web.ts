import { LoadSkiaWeb } from '@shopify/react-native-skia/lib/module/web';

/** react-native-skia's web build needs CanvasKit first. `pnpm prepare-web` copies canvaskit.wasm into public/. */
export const loadSkia = (): Promise<void> => LoadSkiaWeb({ locateFile: (file: string) => `/${file}` });
