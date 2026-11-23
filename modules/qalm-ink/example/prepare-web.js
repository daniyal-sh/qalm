// Copies the web runtime files the example serves from public/: CanvasKit (react-native-skia web) and pdf.js' worker.
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, 'public');
fs.mkdirSync(pub, { recursive: true });
for (const [pkg, file] of [
  ['canvaskit-wasm', 'bin/full/canvaskit.wasm'],
  ['pdfjs-dist', 'build/pdf.worker.min.mjs'],
]) {
  const src = path.join(path.dirname(require.resolve(`${pkg}/package.json`, { paths: [__dirname, path.join(__dirname, '..')] })), file);
  fs.copyFileSync(src, path.join(pub, path.basename(file)));
}
