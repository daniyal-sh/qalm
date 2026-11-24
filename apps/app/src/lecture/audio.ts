// iPad and Android: expo-audio, AAC in ADTS (`.aac`), mono, 32 kbps (docs/lecture-mode.md §1). ADTS needs no index
// written at the end (M4A does), so a file cut off by a crash or an OS kill still plays: the next start recovers it.
// Background recording: app.json enables expo-audio's `enableBackgroundRecording` (Android: a microphone foreground
// service with the system notification; iOS: the `audio` background mode), and the audio mode allows it.
import { AudioModule, requestNotificationPermissionsAsync, requestRecordingPermissionsAsync, setAudioModeAsync, type AudioRecorder, type RecordingStatus } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import type { AudioBackend, ChunkRecorder, RecordedChunk } from './audio.types';

export const AUDIO_BITRATE = 32_000;
export const AUDIO_MIME = 'audio/aac';

/**
 * The platform's flattened recording options, as expo-audio's own hook builds them (utils/options). Android writes
 * ADTS (`aac_adts`); iOS's AVAudioRecorder takes the file type from the `.aac` extension (ADTS), with AAC inside.
 */
function platformOptions(fileName: string): Record<string, unknown> {
  const common = { extension: '.aac', sampleRate: 22_050, numberOfChannels: 1, bitRate: AUDIO_BITRATE, isMeteringEnabled: false, directory: 'document', fileName };
  if (Platform.OS === 'ios') {
    // kAudioFormatMPEG4AAC, medium quality (speech), 16-bit.
    return { ...common, outputFormat: 'aac ', audioQuality: 0x40, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false };
  }
  return { ...common, outputFormat: 'aac_adts', audioEncoder: 'aac' };
}

type Listening = AudioRecorder & { addListener(e: 'recordingStatusUpdate', cb: (s: RecordingStatus) => void): { remove(): void } };

class NativeChunkRecorder implements ChunkRecorder {
  private rec: Listening | null = null;
  private startedAt = 0;
  private n = 0;
  private stopping = false;
  private sub: { remove(): void } | null = null;
  private interrupt = new Set<(why: string) => void>();
  private readonly base = `lecture-${Date.now().toString(36)}`;

  async start(): Promise<void> {
    const Ctor = AudioModule.AudioRecorder as unknown as new (o: Record<string, unknown>) => Listening;
    const rec = new Ctor(platformOptions(`${this.base}-${this.n++}`));
    try {
      await rec.prepareToRecordAsync();
      rec.record();
    } catch (e) {
      rec.release();
      throw e;
    }
    this.rec = rec;
    this.stopping = false;
    this.startedAt = Date.now();
    // The OS ended the recording (a call, Siri, media services reset) or it failed: tell the recorder, once.
    let told = false;
    this.sub = rec.addListener('recordingStatusUpdate', (s) => {
      if (this.stopping || told || this.rec !== rec) return;
      if (s.hasError || s.mediaServicesDidReset || s.isFinished) {
        told = true;
        const why = s.error ?? (s.mediaServicesDidReset ? 'media services were reset' : 'the recording was interrupted');
        for (const cb of [...this.interrupt]) cb(why);
      }
    });
  }

  async stop(): Promise<RecordedChunk | null> {
    const rec = this.rec;
    if (!rec) return null;
    this.stopping = true;
    this.rec = null;
    this.sub?.remove();
    this.sub = null;
    const durMs = Date.now() - this.startedAt;
    const uri = rec.uri;
    try {
      await rec.stop();
    } catch {
      /* already stopped by the OS: the file has what was recorded */
    }
    rec.release();
    if (!uri) return null;
    const f = new File(uri);
    if (!f.exists) return null;
    const bytes = await f.bytes();
    return bytes.length ? { bytes, mime: AUDIO_MIME, durMs, uri } : null;
  }

  async release(): Promise<void> {
    if (this.rec) await this.stop();
    this.interrupt.clear();
    // Ends the background recording session (Android stops the foreground service and its notification).
    await setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false }).catch(() => undefined);
  }

  onInterrupt(cb: (why: string) => void): () => void {
    this.interrupt.add(cb);
    return () => this.interrupt.delete(cb);
  }

  isRecording(): boolean {
    const rec = this.rec;
    if (!rec) return false;
    try {
      return rec.getStatus().isRecording;
    } catch {
      return false;
    }
  }

  currentUri(): string | null {
    return this.rec?.uri ?? null;
  }
}

export const audioBackend: AudioBackend = {
  async permission() {
    const r = await requestRecordingPermissionsAsync();
    // Android 13+: the "qalm is recording" notification needs this; recording itself works without it.
    if (Platform.OS === 'android') await requestNotificationPermissionsAsync().catch(() => undefined);
    return r.granted;
  },
  async open() {
    await setAudioModeAsync({ allowsRecording: true, allowsBackgroundRecording: true, shouldPlayInBackground: true, playsInSilentMode: true });
    return new NativeChunkRecorder();
  },
  async writeTemp(bytes, ext) {
    const f = new File(Paths.cache, `lecture-piece-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    f.create({ overwrite: true });
    f.write(bytes);
    return f.uri;
  },
  async discard(uri) {
    try {
      const f = new File(uri);
      if (f.exists) f.delete();
    } catch {
      /* gone already */
    }
  },
  async readFile(uri) {
    try {
      const f = new File(uri);
      return f.exists ? await f.bytes() : null;
    } catch {
      return null;
    }
  },
};
