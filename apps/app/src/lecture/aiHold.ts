import type { LectureRecorder } from './recorder';

/**
 * Owner decision (docs/lecture-mode.md §1): while a lecture records and AI is playing, sending the app to the
 * background must not pause AI. This holds the open notebook's Play / Pause AI (`AiLive.holdWhileBackgrounded`) for as
 * long as the recorder is starting, recording or resuming, and releases it on pause or stop: releasing while the app
 * is in the background stops sharing then, as backgrounding does without a recording.
 */
export function holdAiWhileRecording(rec: LectureRecorder, hold: (reason: string) => () => void): () => void {
  let release: (() => void) | null = null;
  const sync = () => {
    const on = rec.state === 'starting' || rec.state === 'recording' || rec.state === 'resuming';
    if (on && !release) release = hold('lecture');
    else if (!on && release) {
      const r = release;
      release = null;
      r();
    }
  };
  sync();
  const off = rec.subscribe(sync);
  return () => {
    off();
    release?.();
    release = null;
  };
}
