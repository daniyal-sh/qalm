import * as Y from 'yjs';
import { Zip, ZipDeflate, ZipPassThrough, unzipSync, zipSync, type Zippable } from 'fflate';
import { lectureFiles, readLectureFiles, type LectureBundle } from '../lecture/bundle';

export interface QalmBundle { index: Y.Doc; pages: Map<string, Y.Doc>; assets: Map<string, Uint8Array>; lectures?: LectureBundle[] }

/**
 * Packs a notebook as a `.qalm` zip: `index.bin`, `pages/{pageId}.bin` (Yjs state updates) and `assets/{id}`. With
 * `lectures` (a lecture export, docs/lecture-mode.md §8) each session adds a `lecture/{sessionId}/` folder; without, the
 * file is exactly the plain backup.
 */
export function packQalm(b: QalmBundle): Uint8Array {
  const files: Zippable = { 'index.bin': Y.encodeStateAsUpdate(b.index) };
  for (const [id, doc] of b.pages) files[`pages/${id}.bin`] = Y.encodeStateAsUpdate(doc);
  // Assets are usually compressed already (PDF, PNG, JPEG): store them.
  for (const [id, bytes] of b.assets) files[`assets/${id}`] = [bytes, { level: 0 }];
  for (const lec of b.lectures ?? []) {
    for (const [name, data] of Object.entries(lectureFiles(lec))) files[name] = STORED.test(name) ? [data, { level: 0 }] : data;
  }
  return zipSync(files);
}

const STORED = /\.(png|webm|m4a|ogg|aac|mp3)$/;

/**
 * A lecture export without holding it all in memory twice (docs/lecture-mode.md §8): the same files as `packQalm`,
 * written as a streamed zip. Sessions come one at a time from `sessions` (only one session's audio is held at once),
 * and the zip goes out in parts through `out` (write them to a file, or collect them into a Blob). The plain backup
 * keeps using `packQalm`.
 */
export async function packQalmStream(
  b: Omit<QalmBundle, 'lectures'>,
  sessions: AsyncIterable<LectureBundle>,
  out: (part: Uint8Array) => void | Promise<void>,
): Promise<void> {
  const queue: Uint8Array[] = [];
  let failed: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) failed = err;
    else if (chunk?.length) queue.push(chunk);
  });
  const drain = async () => {
    if (failed) throw failed;
    while (queue.length) await out(queue.shift()!);
  };
  const add = async (name: string, data: Uint8Array, store: boolean) => {
    const f = store ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 });
    zip.add(f);
    f.push(data, true);
    await drain();
  };
  await add('index.bin', Y.encodeStateAsUpdate(b.index), false);
  for (const [id, doc] of b.pages) await add(`pages/${id}.bin`, Y.encodeStateAsUpdate(doc), false);
  for (const [id, bytes] of b.assets) await add(`assets/${id}`, bytes, true);
  for await (const lec of sessions) {
    for (const [name, data] of Object.entries(lectureFiles(lec))) await add(name, data, STORED.test(name));
  }
  zip.end();
  await drain();
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
  // Lecture sessions (absent from a plain backup): read leniently, a broken one is skipped.
  const lectures = readLectureFiles(files);
  return { index, pages, assets, ...(lectures.length ? { lectures } : {}) };
}
