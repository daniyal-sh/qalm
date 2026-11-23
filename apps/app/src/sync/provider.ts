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

export type SyncStatus = 'connecting' | 'connected' | 'synced' | 'offline';

/** Minimal WebSocket surface (browser / React Native / test fake). */
export interface SocketLike {
  binaryType: string;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: Uint8Array): void;
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
}

const OPEN = 1;

/**
 * Yjs sync + awareness over a WebSocket, speaking the y-websocket protocol, with the ticket flow
 * from tech-spec §4: every connection attempt first POSTs for a ticket, so access tokens never go in
 * URLs and a reconnect never reuses a spent ticket.
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
  private listeners = new Set<(s: SyncStatus) => void>();
  private syncedWaiters: (() => void)[] = [];
  private readonly createSocket: SocketFactory;

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
    void this.open();
  }

  disconnect(): void {
    this.wanted = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
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
    this.setStatus('offline');
  }

  destroy(): void {
    this.disconnect();
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    this.awareness.destroy();
    this.listeners.clear();
  }

  private async open(): Promise<void> {
    this.opening = true;
    this.setStatus('connecting');
    let ticket: string;
    try {
      ticket = await this.opts.getTicket(this.docId);
    } catch {
      this.opening = false;
      this.scheduleRetry();
      return;
    }
    this.opening = false;
    if (!this.wanted || this.socket) return;
    const socket = this.createSocket(syncSocketUrl(this.opts.serverUrl, this.docId, ticket));
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      this.setStatus('connected');
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(enc, this.doc);
      socket.send(encoding.toUint8Array(enc));
      if (this.awareness.getLocalState() !== null) socket.send(this.awarenessMessage([this.doc.clientID]));
    };
    socket.onmessage = (ev) => this.onMessage(socket, ev.data);
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.synced = false;
      const others = [...this.awareness.getStates().keys()].filter((c) => c !== this.doc.clientID);
      awarenessProtocol.removeAwarenessStates(this.awareness, others, this);
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    this.setStatus('offline');
    if (!this.wanted) return;
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
