import { registerRootComponent } from 'expo';

import { loadSkia } from './loadSkia';

// App is required only after Skia is ready (on web it needs CanvasKit before any Skia module is evaluated).
loadSkia().then(() => registerRootComponent(require('./App').default));
