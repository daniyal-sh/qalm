// Entry. On web, Skia (CanvasKit) must be loaded before any Skia component renders, so the router
// entry is required only after LoadSkiaWeb resolves. Native platforms start the router directly.
// (A synchronous require in a callback, not import(): async chunks failed to load in the static web export.)
import { Platform } from 'react-native';

if (Platform.OS === 'web') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { LoadSkiaWeb } = require('@shopify/react-native-skia/lib/module/web') as typeof import('@shopify/react-native-skia/lib/module/web');
  // Next to index.html (found from our own script URL), so deep links like /notebook/x and Electron's file:// both work.
  const script = [...document.scripts].find((s) => s.src.includes('/_expo/static/'))?.src;
  const base = script ? script.slice(0, script.indexOf('_expo/static/')) : document.baseURI;
  void LoadSkiaWeb({ locateFile: (file: string) => new URL(file, base).href }).then(() => {
    require('expo-router/entry');
  });
} else {
  require('expo-router/entry');
}
