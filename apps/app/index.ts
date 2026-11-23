// Entry. On web, Skia (CanvasKit) must be loaded before any Skia component renders, so the router
// entry is imported only after LoadSkiaWeb resolves. Native platforms start the router directly.
import { Platform } from 'react-native';

if (Platform.OS === 'web') {
  void (async () => {
    const { LoadSkiaWeb } = await import('@shopify/react-native-skia/lib/module/web');
    // Relative to the page, so the build also works when Electron loads it from disk.
    await LoadSkiaWeb({ locateFile: (file: string) => new URL(file, document.baseURI).href });
    await import('expo-router/entry');
  })();
} else {
  require('expo-router/entry');
}
