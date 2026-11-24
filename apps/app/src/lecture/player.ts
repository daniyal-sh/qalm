// iPad and Android: an expo-audio player, its source replaced per chunk.
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';

import type { ChunkPlayer } from './player.types';

export function createChunkPlayer(): ChunkPlayer {
  let p: AudioPlayer | null = null;
  let rate = 1;
  let loadedAt = 0;
  return {
    async load(uri) {
      if (!p) p = createAudioPlayer(uri, { updateInterval: 100 });
      else p.replace(uri);
      loadedAt = Date.now();
      p.setPlaybackRate(rate, 'medium');
      // Wait (briefly) for the duration to be known, so seeks land.
      for (let i = 0; i < 20 && p.duration <= 0; i++) await new Promise((r) => setTimeout(r, 25));
    },
    play() {
      p?.setPlaybackRate(rate, 'medium');
      p?.play();
    },
    pause() {
      p?.pause();
    },
    seek(sec) {
      void p?.seekTo(Math.max(0, sec));
    },
    setRate(r) {
      rate = r;
      p?.setPlaybackRate(r, 'medium');
    },
    position() {
      return p?.currentTime ?? 0;
    },
    ended() {
      // `didJustFinish` lives on status events; at the end, the time sits at the duration and playback stops.
      return !!p && p.duration > 0 && !p.playing && p.currentTime >= p.duration - 0.05 && Date.now() - loadedAt > 300;
    },
    release() {
      p?.remove();
      p = null;
    },
  };
}
