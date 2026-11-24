// Web and Electron: MediaRecorder, Opus in WebM, mono, ~32 kbps (docs/lecture-mode.md §1). It keeps recording while
// the tab or window is minimised; Electron also turns off background throttling (apps/desktop).
import type { AudioBackend, ChunkRecorder, RecordedChunk } from './audio.types';

export const AUDIO_BITRATE = 32_000;
/** What the web and desktop recorder makes (crash recovery of native ADTS files doesn't apply here). */
export const AUDIO_MIME = 'audio/webm';

function pickMime(): string {
  const want = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];
  const MR = (globalThis as { MediaRecorder?: { isTypeSupported?(t: string): boolean } }).MediaRecorder;
  return want.find((t) => MR?.isTypeSupported?.(t)) ?? '';
}

class WebChunkRecorder implements ChunkRecorder {
  private rec: MediaRecorder | null = null;
  private parts: Blob[] = [];
  private startedAt = 0;
  private done: Promise<void> | null = null;

  constructor(private readonly stream: MediaStream) {}

  async start(): Promise<void> {
    const mimeType = pickMime();
    const rec = new MediaRecorder(this.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: AUDIO_BITRATE });
    this.parts = [];
    this.done = new Promise((resolve) => {
      rec.ondataavailable = (e) => {
        if (e.data.size) this.parts.push(e.data);
      };
      rec.onstop = () => resolve();
    });
    // A timeslice keeps data flowing on long chunks; the parts concatenate into one file.
    rec.start(10_000);
    this.rec = rec;
    this.startedAt = performance.now();
  }

  async stop(): Promise<RecordedChunk | null> {
    const rec = this.rec;
    if (!rec) return null;
    this.rec = null;
    const durMs = Math.round(performance.now() - this.startedAt);
    if (rec.state !== 'inactive') rec.stop();
    await this.done;
    const mime = (rec.mimeType || this.parts[0]?.type || 'audio/webm').split(';')[0]!.trim();
    const blob = new Blob(this.parts, { type: mime });
    this.parts = [];
    if (!blob.size) return null;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime, durMs };
  }

  async release(): Promise<void> {
    if (this.rec) await this.stop();
    for (const t of this.stream.getTracks()) t.stop();
  }
}

export const audioBackend: AudioBackend = {
  async permission() {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  },
  async open() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    return new WebChunkRecorder(stream);
  },
};
