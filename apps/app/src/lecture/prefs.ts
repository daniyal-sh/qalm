import * as React from 'react';

import { kvGet, kvSet } from '../lib/kv';

/** Settings → Lecture mode (per device; docs/lecture-mode.md). Off by default; account-only. */
export interface LecturePrefs {
  enabled: boolean;
  /** "Cloud transcription (Whisper)": chunks go to the server instead of the on-device recognizer. */
  cloud: boolean;
  /** Recognition language (BCP-47, e.g. "en-US"); empty = the device's. */
  lang: string;
}

export const DEFAULT_LECTURE_PREFS: LecturePrefs = { enabled: false, cloud: false, lang: '' };
const KEY = 'lecture:prefs';

let cache: LecturePrefs | null = null;
const listeners = new Set<(p: LecturePrefs) => void>();

export async function loadLecturePrefs(): Promise<LecturePrefs> {
  cache ??= { ...DEFAULT_LECTURE_PREFS, ...((await kvGet<Partial<LecturePrefs>>(KEY)) ?? {}) };
  return cache;
}

export async function setLecturePrefs(patch: Partial<LecturePrefs>): Promise<void> {
  const next = { ...(await loadLecturePrefs()), ...patch };
  cache = next;
  await kvSet(KEY, next);
  for (const l of [...listeners]) l(next);
}

export function useLecturePrefs(): LecturePrefs {
  const [p, setP] = React.useState<LecturePrefs>(cache ?? DEFAULT_LECTURE_PREFS);
  React.useEffect(() => {
    let alive = true;
    void loadLecturePrefs().then((v) => alive && setP(v));
    listeners.add(setP);
    return () => {
      alive = false;
      listeners.delete(setP);
    };
  }, []);
  return p;
}

/** For tests. */
export function resetLecturePrefsCache(): void {
  cache = null;
}
