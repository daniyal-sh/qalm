/**
 * ADTS AAC, the native recorder's format (docs/lecture-mode.md §1): a plain stream of frames, each with its own 7-byte
 * header (length, sample rate). Unlike M4A it needs no index written at the end, so a file cut off by a crash or an OS
 * kill still plays, and it can be cut at any frame into standalone pieces: a long background chunk becomes 2-minute
 * chunks before it is stored, uploaded and transcribed.
 */

const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export interface AdtsFrame {
  /** Byte offset of its header. */
  at: number;
  len: number;
  /** Its length (ms). */
  ms: number;
}

/** The whole frames in `b` (a frame cut off at the end, as after a crash, is left out). */
export function adtsFrames(b: Uint8Array): AdtsFrame[] {
  const out: AdtsFrame[] = [];
  let i = 0;
  while (i + 7 <= b.length) {
    if (b[i] !== 0xff || (b[i + 1]! & 0xf6) !== 0xf0) {
      i++; // not a frame header: resync
      continue;
    }
    const rate = RATES[(b[i + 2]! & 0x3c) >> 2];
    const len = ((b[i + 3]! & 0x03) << 11) | (b[i + 4]! << 3) | ((b[i + 5]! & 0xe0) >> 5);
    if (!rate || len < 7) {
      i++;
      continue;
    }
    if (i + len > b.length) break;
    const blocks = (b[i + 6]! & 0x03) + 1;
    out.push({ at: i, len, ms: (blocks * 1024 * 1000) / rate });
    i += len;
  }
  return out;
}

export function isAdts(b: Uint8Array): boolean {
  return b.length >= 7 && b[0] === 0xff && (b[1]! & 0xf6) === 0xf0;
}

/** Length (ms) of an ADTS stream. */
export function adtsDurationMs(b: Uint8Array): number {
  return Math.round(adtsFrames(b).reduce((n, f) => n + f.ms, 0));
}

/** Cuts an ADTS stream into standalone pieces of at most `maxMs` (views into `b`, not copies). */
export function splitAdts(b: Uint8Array, maxMs: number): { bytes: Uint8Array; t0: number; dur: number }[] {
  const frames = adtsFrames(b);
  const out: { bytes: Uint8Array; t0: number; dur: number }[] = [];
  let first = 0;
  let t0 = 0;
  let dur = 0;
  const flush = (end: number) => {
    if (end <= first) return;
    const a = frames[first]!;
    const z = frames[end - 1]!;
    out.push({ bytes: b.subarray(a.at, z.at + z.len), t0: Math.round(t0), dur: Math.round(dur) });
    t0 += dur;
    dur = 0;
    first = end;
  };
  for (let k = 0; k < frames.length; k++) {
    if (dur + frames[k]!.ms > maxMs && k > first) flush(k);
    dur += frames[k]!.ms;
  }
  flush(frames.length);
  return out;
}
