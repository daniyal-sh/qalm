import * as Y from 'yjs';
import { unzipSync, zipSync, type Zippable } from 'fflate';

export interface QalmBundle { index: Y.Doc; pages: Map<string, Y.Doc>; assets: Map<string, Uint8Array> }

/** Packs a notebook as a `.qalm` zip: `index.bin`, `pages/{pageId}.bin` (Yjs state updates) and `assets/{id}`. */
export function packQalm(b: QalmBundle): Uint8Array {
  const files: Zippable = { 'index.bin': Y.encodeStateAsUpdate(b.index) };
  for (const [id, doc] of b.pages) files[`pages/${id}.bin`] = Y.encodeStateAsUpdate(doc);
  // Assets are usually compressed already (PDF, PNG, JPEG): store them.
  for (const [id, bytes] of b.assets) files[`assets/${id}`] = [bytes, { level: 0 }];
  return zipSync(files);
}

export function unpackQalm(bytes: Uint8Array): QalmBundle {
  const files = unzipSync(bytes);
  const indexBin = files['index.bin'];
  if (!indexBin) throw new Error('Not a .qalm file: index.bin is missing');
  const index = new Y.Doc();
  Y.applyUpdate(index, indexBin);
  const pages = new Map<string, Y.Doc>();
  const assets = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(files)) {
    const page = /^pages\/(.+)\.bin$/.exec(name);
    if (page) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, data);
      pages.set(page[1]!, doc);
    } else if (name.startsWith('assets/') && name.length > 7) {
      assets.set(name.slice(7), data);
    }
  }
  return { index, pages, assets };
}
