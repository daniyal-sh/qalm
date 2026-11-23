import { registerRootComponent } from 'expo';
import { Platform } from 'react-native';

// On web, react-native-skia needs CanvasKit loaded before any Skia module is evaluated, so App is
// required only afterwards. `pnpm prepare-web` copies canvaskit.wasm (and pdf.js' worker) into public/.
if (Platform.OS === 'web') {
  const { LoadSkiaWeb } = require('@shopify/react-native-skia/lib/module/web');
  LoadSkiaWeb({ locateFile: (file: string) => `/${file}` }).then(() => registerRootComponent(require('./App').default));
} else {
  registerRootComponent(require('./App').default);
}
