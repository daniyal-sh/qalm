// Web and Electron: one HTMLAudioElement, its source swapped per chunk.
import type { ChunkPlayer } from './player.types';

export function createChunkPlayer(): ChunkPlayer {
  const el = new Audio();
  el.preload = 'auto';
  let rate = 1;
  return {
    load(uri) {
      return new Promise((resolve) => {
        const done = () => {
          el.removeEventListener('loadedmetadata', done);
          el.removeEventListener('error', done);
          resolve();
        };
        el.addEventListener('loadedmetadata', done);
        el.addEventListener('error', done);
        el.src = uri;
        el.playbackRate = rate;
        el.load();
      });
    },
    play() {
      el.playbackRate = rate;
      void el.play().catch(() => undefined);
    },
    pause() {
      el.pause();
    },
    seek(sec) {
      try {
        el.currentTime = Math.max(0, sec);
      } catch {
        /* not loaded yet */
      }
    },
    setRate(r) {
      rate = r;
      el.playbackRate = r;
    },
    position() {
      return el.currentTime || 0;
    },
    ended() {
      return el.ended;
    },
    release() {
      el.pause();
      el.removeAttribute('src');
      el.load();
    },
  };
}
