/**
 * Play / Pause AI for one open notebook on this device (protocol: core aiLive.ts). Agents get the notebook over MCP
 * only while a device plays it; the server counts a device as playing for AI_LIVE_TTL_MS after its last heartbeat.
 *
 * - Opening a notebook starts paused. `play()` sends `ai:play` (or as soon as the socket is up), then a heartbeat every
 *   AI_LIVE_EVERY_MS. The server's answer carries its pause epoch.
 * - `pause()` (the button) pauses every device. Pressed while the socket is down, it is queued and sent first thing on
 *   reconnect; `pause()` returns false so the editor can say so.
 * - `stop()` stops only this device: the notebook closed, AI access went off.
 * - `background()` / `foreground()`: leaving the app stops this device, unless something holds it
 *   (`holdWhileBackgrounded`, e.g. a running Lecture recording); releasing the last hold while still in the
 *   background stops it then.
 * - The device sleeps (the heartbeat timer froze for longer than the TTL): paused on wake.
 * - The connection drops: the server stops counting this device at once. Back within the TTL, the new socket sends
 *   `ai:resume:<epoch>`, which the server refuses if anyone pressed Pause since (then this device shows paused).
 *   Longer than the TTL, it stays paused.
 * - `ai:paused` from the server (Pause elsewhere, or a refused heartbeat or resume): paused here, and `ai:stop` back
 *   in case a heartbeat crossed it.
 */
import { AI_LIVE, AI_LIVE_EVERY_MS, AI_LIVE_TTL_MS, AI_PAUSE, AI_PAUSED, AI_PLAY, AI_PLAYING, AI_RESUME, AI_STOP } from '@qalm/core';

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
  /** A Pause pressed while the socket was down, not yet delivered to the server. */
  pausePending = false;
  private playPending = false;
  /** The server's pause epoch when it last accepted this device's Play or resume. */
  private epoch: number | null = null;
  /** When this device last got a Play, resume or heartbeat out (wall clock: it runs on while the device sleeps). */
  private lastSentAt = 0;
  private backgrounded = false;
  private readonly holds = new Set<string>();
  private beat: ReturnType<typeof setInterval> | null = null;
  private grace: ReturnType<typeof setTimeout> | null = null;
  private readonly offs: (() => void)[];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly ch: LiveChannel,
    private readonly opts: { everyMs?: number; ttlMs?: number } = {},
  ) {
    this.offs = [ch.onText((m) => this.onText(m)), ch.onStatus((s) => this.onStatus(s))];
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  play(): void {
    if (this.playing) return;
    this.epoch = null;
    this.playPending = !this.send(AI_PLAY);
    this.set(true);
    let tick = Date.now();
    this.beat = setInterval(() => {
      // Timers froze for longer than the TTL: the device slept, and the server has stopped counting it. Stay paused.
      const now = Date.now();
      if (now - tick > (this.opts.ttlMs ?? AI_LIVE_TTL_MS)) return this.stop();
      tick = now;
      this.send(AI_LIVE);
    }, this.opts.everyMs ?? AI_LIVE_EVERY_MS);
    if (this.playPending) this.startGrace();
  }

  /** The Pause button: pauses every device playing this notebook. False when it couldn't go out yet (queued). */
  pause(): boolean {
    const sent = this.send(AI_PAUSE);
    this.pausePending = !sent;
    this.playPending = false;
    this.set(false, true);
    return sent;
  }

  /** This device alone stops (notebook closing, AI access off). */
  stop(): void {
    if (!this.playing) return;
    this.send(AI_STOP);
    this.set(false);
  }

  /** The app went to the background: stops this device unless something holds it. */
  background(): void {
    this.backgrounded = true;
    if (!this.holds.size) this.stop();
  }

  foreground(): void {
    this.backgrounded = false;
  }

  /**
   * Keeps sharing on while the app is in the background, for `reason` (e.g. 'lecture' while a recording runs). Play
   * and Pause work as usual. Returns the release; releasing the last hold while still in the background stops sharing.
   */
  holdWhileBackgrounded(reason: string): () => void {
    this.holds.add(reason);
    return () => this.release(reason);
  }

  release(reason: string): void {
    if (!this.holds.delete(reason)) return;
    if (!this.holds.size && this.backgrounded) this.stop();
  }

  destroy(): void {
    this.stop();
    for (const off of this.offs) off();
    this.listeners.clear();
    this.holds.clear();
  }

  private send(msg: string): boolean {
    const ok = this.ch.sendText(msg);
    if (ok && msg !== AI_PAUSE && msg !== AI_STOP) this.lastSentAt = Date.now();
    return ok;
  }

  private onText(m: string): void {
    if (m.startsWith(AI_PLAYING)) {
      if (this.playing) this.epoch = Number(m.slice(AI_PLAYING.length));
    } else if (m === AI_PAUSED) {
      // Paused elsewhere, or the server refused a heartbeat or resume. `ai:stop` clears this socket in case one of
      // our heartbeats crossed the Pause.
      if (this.playing) this.send(AI_STOP);
      this.set(false);
    }
  }

  private onStatus(s: SyncStatus): void {
    if (s === 'connected') {
      // A new socket after a reconnect: the server knows nothing of this device yet. A queued Pause goes first.
      if (this.pausePending && this.send(AI_PAUSE)) {
        this.pausePending = false;
        this.emit();
      }
      if (!this.playing) return;
      if (this.playPending) {
        this.playPending = !this.send(AI_PLAY);
      } else if (this.epoch !== null && Date.now() - this.lastSentAt <= (this.opts.ttlMs ?? AI_LIVE_TTL_MS)) {
        this.send(`${AI_RESUME}${this.epoch}`);
      } else {
        // Gone longer than the TTL (or Play never got an answer): sharing ended; Play again to share.
        return this.set(false);
      }
      this.clearGrace();
    } else if (up(s)) {
      if (this.playing) this.clearGrace();
    } else if (this.playing) this.startGrace();
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

  private set(playing: boolean, force = false): void {
    if (!playing) {
      if (this.beat) clearInterval(this.beat);
      this.beat = null;
      this.clearGrace();
      this.playPending = false;
    }
    if (this.playing === playing && !force) return;
    this.playing = playing;
    this.emit();
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}
