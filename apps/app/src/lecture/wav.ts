/**
 * WAV for the macOS speech helper (docs/lecture-mode.md §4): Electron records Opus in WebM, which AVFoundation (and so
 * Apple's recognizer) can't read. The renderer decodes the chunk with Web Audio and hands the helper 16 kHz mono PCM.
 */

/** 16-bit PCM mono WAV from samples in [-1, 1]. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const str = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return out;
}

/** Decodes a recorded chunk (any format the browser plays) to 16 kHz mono WAV. Renderer only (Web Audio). */
export async function decodeToWav(bytes: Uint8Array, sampleRate = 16_000): Promise<Uint8Array> {
  const decoder = new OfflineAudioContext(1, 1, 44_100);
  const buf = await decoder.decodeAudioData(bytes.slice().buffer);
  const frames = Math.max(1, Math.ceil(buf.duration * sampleRate));
  // A one-channel context mixes the source down to mono while resampling.
  const ctx = new OfflineAudioContext(1, frames, sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return encodeWav(out.getChannelData(0), sampleRate);
}
