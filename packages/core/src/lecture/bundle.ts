import * as Y from 'yjs';
import { strFromU8, strToU8 } from 'fflate';
import { LectureDoc } from './doc';
import { eventsFromJsonl, eventsToJsonl, fmtT } from './timeline';
import type { AudioChunk, LectureCrop, LectureEvent, LectureMeta, TranscriptSegment } from './types';

/** One session as it goes into (or comes out of) a lecture `.qalm` (docs/lecture-mode.md §8). */
export interface LectureBundle {
  meta: LectureMeta;
  /** Pages the session touched, with their 1-based position at export. */
  pages: { id: string; n: number }[];
  events: LectureEvent[];
  /** Audio chunks with their bytes (missing bytes: the chunk is listed in session.json but not stored). */
  audio: { chunk: AudioChunk; bytes?: Uint8Array }[];
  crops: { crop: LectureCrop; png?: Uint8Array }[];
  transcript: TranscriptSegment[];
}

const EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
const pad = (n: number) => String(n).padStart(3, '0');
const baseMime = (m: string) => m.split(';')[0]!.trim();

/** The plain explanation shipped in every session folder, for any agent reading the export without qalm's code. */
export function lectureReadme(meta: LectureMeta): string {
  return `# A qalm lecture recording

This folder is one recorded lecture: audio, every pen event and a timed transcript, all on one timeline.
Recorded ${new Date(meta.startedAt).toISOString()}, ${fmtT(meta.durationMs)} long.

**Time.** Every \`t\` is milliseconds on the lecture's timeline. It starts at 0 when recording starts and only runs while
recording (pauses take no time), so the timeline and the audio line up exactly.

**Pages and coordinates.** The notebook's pages are in the rest of this \`.qalm\` file. Page ids (\`p\`) match it;
\`session.json\` lists each page's position (\`n\`, 1-based). Ink coordinates are PDF points (A4 is 595 x 842,
origin top left).

## Files

- \`session.json\`: id, start time (ms since epoch), length (ms) and pages.
- \`timeline.jsonl\`: one JSON event per line, in time order:
  - \`start\`: \`at\` is the wall-clock start.
  - \`page\`: the writer turned to page \`p\` (position \`n\`).
  - \`base\`: \`ids\` of the ink already on page \`p\` when the lecture first showed it.
  - \`add\`: \`items\` written on page \`p\`.
  - \`erase\`: \`items\` erased from page \`p\`. They keep their full points, so you can see what was erased.
  - \`update\`: \`items\` moved, resized, rotated or recoloured, as they are afterwards. \`before\` holds an item's
    earlier copy when it was base ink.
  - \`by: "undo"\` or \`"redo"\` marks an undo or redo.
  - \`pause\`, \`resume\`, \`stop\`.
  - An item is \`{id, type: "stroke"|"shape"|"text"|"image", ...}\`. A stroke has \`tool\` (pen or highlighter),
    \`color\`, \`width\` and \`points\`: \`[x, y, pressure 0-1, tilt (rad, 1.571 = upright), azimuth (rad), ms since the
    stroke began]\`. The stroke's first point was drawn at the event's \`t\` minus the last point's ms. A shape has
    \`kind\` and corner points \`pts\`; text has \`x, y, w, text, fontSize\`.
- \`audio/\`: the recording as chunks, in order. \`NNN-T.ext\` starts at timeline ms \`T\` (Opus in WebM, or AAC in
  M4A; mono speech).
- \`transcript.json\`: \`[{t0, t1, text, words?: [{w, t0, t1}]}]\`, times on the timeline.
- \`crops/\`: what an AI agent following the lecture live was sent when the writer paused. \`NNN-T.png\` is the image:
  rows labelled \`[1]\`, \`[2]\`...; new ink is black, the ink around it grey, erased ink faint red and dashed.
  \`NNN-T.json\` is \`{t, text, regions}\`. \`text\` is the update in Q-ink: \`R7 [1] p2 @120,300 260x80 +5 -1\` is
  region R7, row 1 of the image, on page 2, its box at x,y with width x height on a 0-1000 grid across the page width,
  with 5 strokes added and 1 erased.

## Reading the lecture

Merge \`transcript.json\` and \`crops/\` by time to follow what was said next to what was written. For exact ink at a
moment, start from each page's \`base\` ink and apply \`timeline.jsonl\` events up to that \`t\`.
`;
}

/** The files of one session, under `lecture/{sessionId}/`. */
export function lectureFiles(b: LectureBundle): Record<string, Uint8Array> {
  const dir = `lecture/${b.meta.id}/`;
  const files: Record<string, Uint8Array> = {};
  files[`${dir}LECTURE.md`] = strToU8(lectureReadme(b.meta));
  files[`${dir}session.json`] = strToU8(JSON.stringify({ ...b.meta, pages: b.pages, audio: b.audio.map((a) => a.chunk) }, null, 2));
  files[`${dir}timeline.jsonl`] = strToU8(eventsToJsonl(b.events));
  files[`${dir}transcript.json`] = strToU8(JSON.stringify(b.transcript.map(({ src: _src, ...s }) => s)));
  b.audio.forEach((a, i) => {
    if (a.bytes) files[`${dir}audio/${pad(i)}-${Math.round(a.chunk.t0)}.${EXT[baseMime(a.chunk.mime)] ?? 'bin'}`] = a.bytes;
  });
  b.crops.forEach((c, i) => {
    const name = `${dir}crops/${pad(i)}-${Math.round(c.crop.t)}`;
    if (c.png) files[`${name}.png`] = c.png;
    files[`${name}.json`] = strToU8(JSON.stringify({ t: c.crop.t, text: c.crop.text, regions: c.crop.regions, w: c.crop.w, h: c.crop.h }));
  });
  return files;
}

/** Reads the sessions back from a `.qalm`'s files. Broken sessions are skipped, never thrown. */
export function readLectureFiles(files: Record<string, Uint8Array>): LectureBundle[] {
  const dirs = new Map<string, Record<string, Uint8Array>>();
  for (const [name, data] of Object.entries(files)) {
    const m = /^lecture\/([^/]+)\/(.+)$/.exec(name);
    if (!m) continue;
    if (!dirs.has(m[1]!)) dirs.set(m[1]!, {});
    dirs.get(m[1]!)![m[2]!] = data;
  }
  const out: LectureBundle[] = [];
  for (const [id, f] of dirs) {
    try {
      const s = JSON.parse(strFromU8(f['session.json']!)) as LectureMeta & { pages?: { id: string; n: number }[]; audio?: AudioChunk[] };
      const listed = s.audio ?? [];
      const audioFiles = Object.keys(f).filter((n) => n.startsWith('audio/')).sort();
      const audio = audioFiles.map((n, i) => {
        const m = /^audio\/\d+-(\d+)\.(\w+)$/.exec(n);
        const t0 = m ? Number(m[1]) : 0;
        const chunk = listed.find((c) => Math.round(c.t0) === t0) ?? listed[i];
        const bytes = f[n]!;
        return { chunk: { sha: chunk?.sha ?? '', mime: chunk?.mime ?? MIME[m?.[2] ?? ''] ?? 'application/octet-stream', t0, dur: chunk?.dur ?? 0, bytes: bytes.length }, bytes };
      });
      const crops = Object.keys(f)
        .filter((n) => /^crops\/.+\.json$/.test(n))
        .sort()
        .map((n) => {
          const j = JSON.parse(strFromU8(f[n]!)) as LectureCrop;
          const png = f[n.replace(/\.json$/, '.png')];
          return { crop: { t: j.t, sha: '', w: j.w ?? 0, h: j.h ?? 0, text: j.text ?? '', regions: j.regions ?? [] }, ...(png ? { png } : {}) };
        });
      const transcript = f['transcript.json'] ? (JSON.parse(strFromU8(f['transcript.json'])) as TranscriptSegment[]) : [];
      out.push({
        meta: { id, notebookId: s.notebookId ?? '', startedAt: Number(s.startedAt) || 0, durationMs: Number(s.durationMs) || 0, state: 'stopped', lastT: Number(s.lastT) || 0, transcriber: s.transcriber ?? 'none', ...(s.title ? { title: s.title } : {}) },
        pages: s.pages ?? [],
        events: f['timeline.jsonl'] ? eventsFromJsonl(strFromU8(f['timeline.jsonl'])) : [],
        audio,
        crops,
        transcript,
      });
    } catch {
      /* not a session we can read: skip it */
    }
  }
  return out;
}

/** Collects a session doc into a bundle (asset bytes are filled in by the caller). */
export function lectureBundleOf(lec: LectureDoc, pagePos: (pageId: string) => number): LectureBundle {
  const events = lec.events();
  const ids = [...new Set(events.flatMap((e) => ('p' in e ? [e.p] : [])))];
  return {
    meta: lec.meta(),
    pages: ids.map((id) => ({ id, n: pagePos(id) })).filter((p) => p.n > 0),
    events,
    audio: lec.audio().map((chunk) => ({ chunk })),
    crops: lec.crops().map((crop) => ({ crop })),
    transcript: lec.transcript(),
  };
}

/**
 * A new session doc from an imported bundle: new session and notebook ids, page ids mapped (events on pages that
 * weren't restored are dropped). `shas` gives each audio chunk's and crop's asset sha (by index), once stored.
 */
export function lectureDocFromBundle(
  b: LectureBundle,
  opts: { sessionId: string; notebookId: string; pageIds: Map<string, string>; audioShas: string[]; cropShas: string[] },
): Y.Doc {
  const doc = new Y.Doc();
  const lec = new LectureDoc(doc);
  const map = (p: string) => opts.pageIds.get(p);
  const events = b.events.flatMap((e): LectureEvent[] => {
    if (!('p' in e)) return [e];
    const p = map(e.p);
    return p ? [{ ...e, p } as LectureEvent] : [];
  });
  lec.setMeta({ ...b.meta, id: opts.sessionId, notebookId: opts.notebookId, state: 'stopped' });
  if (events.length) lec.appendEvents(events);
  b.audio.forEach((a, i) => {
    if (opts.audioShas[i]) lec.addAudio({ ...a.chunk, sha: opts.audioShas[i]! });
  });
  lec.addTranscript(b.transcript);
  b.crops.forEach((c, i) => {
    if (opts.cropShas[i]) lec.addCrop({ ...c.crop, sha: opts.cropShas[i]! });
  });
  lec.setMeta({ durationMs: b.meta.durationMs, lastT: b.meta.lastT });
  return doc;
}
