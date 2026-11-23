// Entry. On web, Skia (CanvasKit) must be loaded before any Skia component renders, so the router
// entry is required only after LoadSkiaWeb resolves. Native platforms start the router directly.
// (A synchronous require in a callback, not import(): async chunks failed to load in the static web export.)
import { Platform } from 'react-native';

if (Platform.OS === 'web') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { LoadSkiaWeb } = require('@shopify/react-native-skia/lib/module/web') as typeof import('@shopify/react-native-skia/lib/module/web');
  // Relative to the page, so the build also works when Electron loads it from disk.
  void LoadSkiaWeb({ locateFile: (file: string) => new URL(file, document.baseURI).href }).then(() => {
    require('expo-router/entry');
  });
} else {
  require('expo-router/entry');
}
