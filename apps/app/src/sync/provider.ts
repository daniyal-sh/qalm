import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import type * as Y from 'yjs';

import { syncSocketUrl } from './ticket';

/** y-websocket message types (wire-compatible with y-websocket servers). */
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_AUTH = 2;
export const MESSAGE_QUERY_AWARENESS = 3;

/**
 * `reconnecting`: the connection was lost (or didn't come up) and a retry with a fresh ticket is pending.
 * `offline`: the device is offline, or sync was stopped.
 */
export type SyncStatus = 'connecting' | 'connected' | 'synced' | 'reconnecting' | 'offline';

/** Text heartbeat: the server answers `ping` with `pong` without waking its Durable Object (setWebSocketAutoResponse). */
export const PING = 'ping';
export const PONG = 'pong';

/** Network and app lifecycle signals (see `network.ts`). */
export interface NetworkEvents {
  online(): void;
  offline(): void;
  /** The app came back to the foreground: check the connection now. */
  foreground(): void;
}
export type WatchNetwork = (events: NetworkEvents) => () => void;

/** Minimal WebSocket surface (browser / React Native / test fake). */
export interface SocketLike {
  binaryType: string;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: Uint8Array | string): void;
  close(): void;
}
export type SocketFactory = (url: string) => SocketLike;

export interface SyncProviderOptions {
  serverUrl: string;
  /** Fetches a fresh single-use ticket for every (re)connect. */
  getTicket: (docId: string) => Promise<string>;
  createSocket?: SocketFactory;
  /** Reconnect backoff bounds (ms). */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Connect immediately (default true). */
  connect?: boolean;
  /** Silence before a ping (default 20 s), and how long to wait for any answer before the socket counts as dead (default 8 s). */
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
  /** Subscribes to online/offline and foreground events; unsubscribed on destroy. */
  watchNetwork?: WatchNetwork;
}

const OPEN = 1;

/**
 * Yjs sync + awareness over a WebSocket, speaking the y-websocket protocol, with the ticket flow
 * from tech-spec §4: every connection attempt first POSTs for a ticket, so access tokens never go in
 * URLs and a reconnect never reuses a spent ticket.
 *
 * A connection can die without a close event (Wi-Fi drops, the app is suspended), so after `heartbeatMs` of silence
 * the provider sends a ping, and if nothing at all arrives within `heartbeatTimeoutMs` it drops the socket and
 * reconnects. No edit is lost: every (re)connect starts with sync step 1 both ways, which sends whatever the other
 * side lacks, including updates that went into the dead socket.
 */
export class SyncProvider {
  readonly awareness: awarenessProtocol.Awareness;
  status: SyncStatus = 'offline';
  synced = false;
  private socket: SocketLike | null = null;
  private wanted = false;
  private opening = false;
  private attempts = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setTimeout> | null = null;
  private networkDown = false;
  private listeners = new Set<(s: SyncStatus) => void>();
  private syncedWaiters: (() => void)[] = [];
  private readonly createSocket: SocketFactory;
  private readonly unwatch: (() => void) | null;

  constructor(
    readonly doc: Y.Doc,
    readonly docId: string,
    private readonly opts: SyncProviderOptions,
  ) {
    this.awareness = new awarenessProtocol.Awareness(doc);
    this.createSocket =
      opts.createSocket ??
      ((url) => new (globalThis as unknown as { WebSocket: new (u: string) => SocketLike }).WebSocket(url));
    doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
    this.unwatch =
      opts.watchNetwork?.({
        online: () => this.setNetwork(true),
        offline: () => this.setNetwork(false),
        foreground: () => this.check(),
      }) ?? null;
    if (opts.connect !== false) this.connect();
  }

  onStatus(cb: (s: SyncStatus) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Resolves when the first sync with the server completed (immediately if already synced). */
  whenSynced(): Promise<void> {
    if (this.synced) return Promise.resolve();
    return new Promise((r) => this.syncedWaiters.push(r));
  }

  private setStatus(s: SyncStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const l of [...this.listeners]) l(s);
  }

  connect(): void {
    this.wanted = true;
    if (this.socket || this.retry || this.opening) return;
    if (this.networkDown) return this.setStatus('offline');
    void this.open();
  }

  disconnect(): void {
    this.wanted = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.dropSocket();
    this.setStatus('offline');
  }

  /**
   * Is the connection still alive? Pings now when connected (a dead socket is dropped within `heartbeatTimeoutMs`),
   * or retries at once when waiting to reconnect. Called when the app returns to the foreground.
   */
  check(): void {
    if (!this.wanted || this.networkDown) return;
    if (this.socket) {
      if (this.socket.readyState === OPEN) this.ping();
      return;
    }
    this.retryNow();
  }

  /** The device went offline or came back online. */
  setNetwork(online: boolean): void {
    if (online !== this.networkDown) return; // no change
    this.networkDown = !online;
    if (!online) {
      if (this.retry) clearTimeout(this.retry);
      this.retry = null;
      this.dropSocket();
      this.setStatus('offline');
      return;
    }
    if (this.wanted) {
      this.setStatus('reconnecting');
      this.retryNow();
    }
  }

  destroy(): void {
    this.unwatch?.();
    this.disconnect();
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    this.awareness.destroy();
    this.listeners.clear();
  }

  private async open(): Promise<void> {
    this.opening = true;
    this.setStatus(this.status === 'reconnecting' ? 'reconnecting' : 'connecting');
    let ticket: string;
    try {
      ticket = await this.opts.getTicket(this.docId);
    } catch {
      this.opening = false;
      this.scheduleRetry();
      return;
    }
    this.opening = false;
    if (!this.wanted || this.socket || this.networkDown) return;
    const socket = this.createSocket(syncSocketUrl(this.opts.serverUrl, this.docId, ticket));
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    // A socket that never opens (nor closes) counts as lost too.
    this.heartbeat = setTimeout(() => {
      if (this.socket === socket) this.lost();
    }, 2 * (this.opts.heartbeatTimeoutMs ?? 8_000));
    socket.onopen = () => {
      this.attempts = 0;
      this.setStatus('connected');
      this.armHeartbeat();
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(enc, this.doc);
      socket.send(encoding.toUint8Array(enc));
      if (this.awareness.getLocalState() !== null) socket.send(this.awarenessMessage([this.doc.clientID]));
    };
    socket.onmessage = (ev) => this.onMessage(socket, ev.data);
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (this.socket === socket) this.lost();
    };
  }

  /** The socket closed or went silent: drop it and reconnect with backoff. */
  private lost(): void {
    this.dropSocket();
    this.scheduleRetry();
  }

  private dropSocket(): void {
    if (this.heartbeat) clearTimeout(this.heartbeat);
    this.heartbeat = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = s.onmessage = s.onerror = s.onopen = null;
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    const others = [...this.awareness.getStates().keys()].filter((c) => c !== this.doc.clientID);
    awarenessProtocol.removeAwarenessStates(this.awareness, others, this);
    this.synced = false;
  }

  /** After `heartbeatMs` without a message, ping. Every message re-arms it. */
  private armHeartbeat(): void {
    if (this.heartbeat) clearTimeout(this.heartbeat);
    this.heartbeat = setTimeout(() => this.ping(), this.opts.heartbeatMs ?? 20_000);
  }

  /** Send a ping; if nothing arrives within `heartbeatTimeoutMs`, the connection is dead. */
  private ping(): void {
    const s = this.socket;
    if (!s) return;
    if (this.heartbeat) clearTimeout(this.heartbeat);
    this.heartbeat = setTimeout(() => {
      if (this.socket === s) this.lost();
    }, this.opts.heartbeatTimeoutMs ?? 8_000);
    try {
      s.send(PING);
    } catch {
      this.lost();
    }
  }

  private retryNow(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.attempts = 0;
    if (!this.socket && !this.opening) void this.open();
  }

  private scheduleRetry(): void {
    if (!this.wanted || this.networkDown) return this.setStatus('offline');
    this.setStatus('reconnecting');
    const min = this.opts.minBackoffMs ?? 500;
    const max = this.opts.maxBackoffMs ?? 30_000;
    const delay = Math.min(max, min * 2 ** this.attempts);
    this.attempts++;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.wanted && !this.socket) void this.open();
    }, delay);
  }

  private onMessage(socket: SocketLike, data: unknown): void {
    if (this.socket === socket) this.armHeartbeat(); // anything counts as a sign of life
    if (typeof data === 'string') return; // pong
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    const dec = decoding.createDecoder(bytes);
    const enc = encoding.createEncoder();
    const type = decoding.readVarUint(dec);
    switch (type) {
      case MESSAGE_SYNC: {
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        const kind = syncProtocol.readSyncMessage(dec, enc, this.doc, this);
        if (kind === syncProtocol.messageYjsSyncStep2 && !this.synced) {
          this.synced = true;
          this.setStatus('synced');
          for (const w of this.syncedWaiters.splice(0)) w();
        }
        break;
      }
      case MESSAGE_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this);
        return;
      case MESSAGE_QUERY_AWARENESS:
        socket.send(this.awarenessMessage([...this.awareness.getStates().keys()]));
        return;
      case MESSAGE_AUTH:
        // Permission denied for this doc: stop (no retry loop).
        this.disconnect();
        return;
      default:
        return;
    }
    if (encoding.length(enc) > 1 && socket.readyState === OPEN) socket.send(encoding.toUint8Array(enc));
  }

  private awarenessMessage(clients: number[]): Uint8Array {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients));
    return encoding.toUint8Array(enc);
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return;
    const s = this.socket;
    if (!s || s.readyState !== OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    s.send(encoding.toUint8Array(enc));
  };

  private readonly onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this) return;
    const s = this.socket;
    if (!s || s.readyState !== OPEN) return;
    s.send(this.awarenessMessage([...added, ...updated, ...removed]));
  };
}
