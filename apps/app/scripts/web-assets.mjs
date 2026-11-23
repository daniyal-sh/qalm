// Copies files the web build loads at runtime into public/ (served next to index.html):
// - canvaskit.wasm for @shopify/react-native-skia on web (PageCanvas)
// - pdf.worker.min.mjs for pdf.js (QalmInk.renderPdfPage on web)
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', 'package.json'));
const pub = join(here, '..', 'public');
mkdirSync(pub, { recursive: true });

const skia = dirname(require.resolve('@shopify/react-native-skia/package.json'));
const ckReq = createRequire(join(skia, 'package.json'));
const canvaskit = join(dirname(ckReq.resolve('canvaskit-wasm/package.json')), 'bin', 'full', 'canvaskit.wasm');
const inkReq = createRequire(require.resolve('qalm-ink/package.json'));
const pdfWorker = join(dirname(inkReq.resolve('pdfjs-dist/package.json')), 'build', 'pdf.worker.min.mjs');

for (const [from, name] of [[canvaskit, 'canvaskit.wasm'], [pdfWorker, 'pdf.worker.min.mjs']]) {
  copyFileSync(from, join(pub, name));
  console.log(`web-assets: ${name}`);
}
