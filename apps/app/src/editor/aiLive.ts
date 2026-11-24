/**
 * Play / Pause AI for one open notebook on this device (protocol: core aiLive.ts). Agents get the notebook over MCP
 * only while a device plays it; the server counts a device as playing for AI_LIVE_TTL_MS after its last heartbeat.
 *
 * - Opening a notebook starts paused. `play()` sends a heartbeat now and every AI_LIVE_EVERY_MS.
 * - `pause()` (the button) pauses every device; the server tells the others, which switch to paused here.
 * - `stop()` stops only this device: the app went to the background, the notebook closed, AI access went off.
 * - The connection drops: the server stops counting this device at once. If the socket is back within the TTL the
 *   heartbeat resumes (a Wi-Fi blip doesn't need another Play); otherwise it stays paused.
 */
import { AI_LIVE, AI_LIVE_EVERY_MS, AI_LIVE_TTL_MS, AI_PAUSE, AI_PAUSED, AI_STOP } from '@qalm/core';

import type { SyncStatus } from '../sync/provider';

/** The parts of SyncProvider this needs. */
export interface LiveChannel {
  status: SyncStatus;
  sendText(msg: string): boolean;
  onText(cb: (msg: string) => void): () => void;
  onStatus(cb: (s: SyncStatus) => void): () => void;
}

const up = (s: SyncStatus) => s === 'connected' || s === 'synced';

export class AiLive {
  playing = false;
  private beat: ReturnType<typeof setInterval> | null = null;
  private grace: ReturnType<typeof setTimeout> | null = null;
  private readonly offs: (() => void)[];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly ch: LiveChannel,
    private readonly opts: { everyMs?: number; ttlMs?: number } = {},
  ) {
    this.offs = [
      ch.onText((m) => {
        if (m === AI_PAUSED) this.set(false);
      }),
      ch.onStatus((s) => this.onStatus(s)),
    ];
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  play(): void {
    if (this.playing) return;
    this.set(true);
    this.ch.sendText(AI_LIVE);
    this.beat = setInterval(() => this.ch.sendText(AI_LIVE), this.opts.everyMs ?? AI_LIVE_EVERY_MS);
    if (!up(this.ch.status)) this.startGrace();
  }

  /** The Pause button: pauses every device playing this notebook. */
  pause(): void {
    this.ch.sendText(AI_PAUSE);
    this.set(false);
  }

  /** This device alone stops (backgrounded, notebook closing). */
  stop(): void {
    if (!this.playing) return;
    this.ch.sendText(AI_STOP);
    this.set(false);
  }

  destroy(): void {
    this.stop();
    for (const off of this.offs) off();
    this.listeners.clear();
  }

  private onStatus(s: SyncStatus): void {
    if (!this.playing) return;
    if (up(s)) {
      // A new socket after a reconnect: the server knows nothing of it yet.
      if (s === 'connected') this.ch.sendText(AI_LIVE);
      this.clearGrace();
    } else this.startGrace();
  }

  private startGrace(): void {
    if (this.grace) return;
    this.grace = setTimeout(() => {
      this.grace = null;
      this.set(false);
    }, this.opts.ttlMs ?? AI_LIVE_TTL_MS);
  }

  private clearGrace(): void {
    if (this.grace) clearTimeout(this.grace);
    this.grace = null;
  }

  private set(playing: boolean): void {
    if (!playing) {
      if (this.beat) clearInterval(this.beat);
      this.beat = null;
      this.clearGrace();
    }
    if (this.playing === playing) return;
    this.playing = playing;
    for (const l of [...this.listeners]) l();
  }
}
