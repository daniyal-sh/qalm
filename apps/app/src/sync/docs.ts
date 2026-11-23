import * as Y from 'yjs';

import type { DocPersistence } from './snapshot';
import type { SyncProvider } from './provider';

export interface DocHandle {
  readonly docId: string;
  readonly doc: Y.Doc;
  /** Local state applied. */
  readonly loaded: Promise<void>;
  /** The live provider, when a server is configured and the user is signed in. */
  provider(): SyncProvider | null;
  release(): void;
}

/** Creates the sync provider for a doc, or null for docs that never sync (e.g. the signed-out library). */
export type RemoteFactory = (docId: string, doc: Y.Doc) => SyncProvider | null;

export interface DocManagerDeps {
  persist: (docId: string, doc: Y.Doc) => DocPersistence;
  /** Creates a provider for a doc, or null when offline. */
  remote: RemoteFactory | null;
  /** Released docs kept in memory (provider disconnected) before eviction. */
  cacheSize?: number;
}

interface Entry {
  docId: string;
  doc: Y.Doc;
  persistence: DocPersistence;
  provider: SyncProvider | null;
  refs: number;
  lastUsed: number;
}

/**
 * Opens docs with local persistence and (optionally) sync. Ref-counted: a doc stays connected while
 * any handle holds it. Released docs stay in a small LRU (so per-page undo history survives
 * scrolling away and back) and are flushed and destroyed on eviction.
 */
export class DocManager {
  private entries = new Map<string, Entry>();
  private evictListeners = new Set<(docId: string) => void>();
  private remoteListeners = new Set<() => void>();
  private updateListeners = new Set<(docId: string) => void>();
  private clock = 0;
  private retain: (docId: string) => boolean = () => false;

  constructor(private deps: DocManagerDeps) {}

  get online(): boolean {
    return this.deps.remote !== null;
  }

  onEvict(cb: (docId: string) => void): () => void {
    this.evictListeners.add(cb);
    return () => {
      this.evictListeners.delete(cb);
    };
  }

  /**
   * Idle docs for which `fn` is true are evicted last (the editor keeps pages with undo history in memory, so undo
   * still reaches them after scrolling away). The cache stays bounded: they are evicted too once it overflows.
   */
  setRetain(fn: ((docId: string) => boolean) | null): void {
    this.retain = fn ?? (() => false);
  }

  /** Called when an open or cached doc changes after its local state loaded (local edits, sync, undo). */
  onUpdate(cb: (docId: string) => void): () => void {
    this.updateListeners.add(cb);
    return () => {
      this.updateListeners.delete(cb);
    };
  }

  /** Called after setRemote (providers were replaced). */
  onRemoteChange(cb: () => void): () => void {
    this.remoteListeners.add(cb);
    return () => {
      this.remoteListeners.delete(cb);
    };
  }

  open(docId: string): DocHandle {
    let e = this.entries.get(docId);
    if (!e) {
      const doc = new Y.Doc({ guid: docId });
      e = { docId, doc, persistence: this.deps.persist(docId, doc), provider: null, refs: 0, lastUsed: 0 };
      this.entries.set(docId, e);
      let loaded = false;
      void e.persistence.whenSynced.then(() => {
        loaded = true;
      });
      doc.on('update', () => {
        if (loaded) for (const l of [...this.updateListeners]) l(docId);
      });
    }
    const entry = e;
    entry.refs++;
    entry.lastUsed = ++this.clock;
    if (!entry.provider && this.deps.remote) entry.provider = this.deps.remote(docId, entry.doc);
    else entry.provider?.connect();
    let released = false;
    return {
      docId,
      doc: entry.doc,
      loaded: entry.persistence.whenSynced,
      provider: () => entry.provider,
      release: () => {
        if (released) return;
        released = true;
        this.release(entry);
      },
    };
  }

  /** Is the doc currently held open (refs > 0)? */
  isOpen(docId: string): boolean {
    return (this.entries.get(docId)?.refs ?? 0) > 0;
  }

  /** How many docs are held open and how many idle ones are cached (benchmarks, tests). */
  stats(): { open: number; cached: number } {
    let open = 0;
    for (const e of this.entries.values()) if (e.refs > 0) open++;
    return { open, cached: this.entries.size - open };
  }

  /** Is the doc in memory (open or cached)? */
  has(docId: string): boolean {
    return this.entries.has(docId);
  }

  private release(e: Entry): void {
    e.refs = Math.max(0, e.refs - 1);
    e.lastUsed = ++this.clock;
    if (e.refs === 0) {
      e.provider?.disconnect();
      void e.persistence.flush();
      this.trim();
    }
  }

  private trim(): void {
    const max = this.deps.cacheSize ?? 24;
    const keep = (e: Entry) => (this.retain(e.docId) ? 1 : 0);
    const idle = [...this.entries.values()].filter((e) => e.refs === 0).sort((a, b) => keep(a) - keep(b) || a.lastUsed - b.lastUsed);
    while (idle.length > max) this.evict(idle.shift()!);
  }

  private evict(e: Entry): void {
    this.entries.delete(e.docId);
    e.provider?.destroy();
    for (const l of [...this.evictListeners]) l(e.docId);
    void e.persistence.destroy().finally(() => e.doc.destroy());
  }

  /** Forgets a doc entirely (permanent delete). */
  async drop(docId: string): Promise<void> {
    const e = this.entries.get(docId);
    if (!e) return;
    this.entries.delete(docId);
    e.provider?.destroy();
    for (const l of [...this.evictListeners]) l(docId);
    await e.persistence.destroy();
    e.doc.destroy();
  }

  /** Switches between offline and synced (sign-in / sign-out). Open docs reconnect. */
  setRemote(remote: RemoteFactory | null): void {
    this.deps = { ...this.deps, remote };
    for (const e of this.entries.values()) {
      e.provider?.destroy();
      e.provider = remote && e.refs > 0 ? remote(e.docId, e.doc) : null;
    }
    for (const l of [...this.remoteListeners]) l();
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => e.persistence.flush()));
  }

  /** Destroys everything (sign-out, tests). */
  async closeAll(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(
      all.map(async (e) => {
        e.provider?.destroy();
        await e.persistence.destroy();
        e.doc.destroy();
      }),
    );
  }
}

export const docIds = {
  library: (userId: string) => `lib:${userId}`,
  notebook: (id: string) => `nb:${id}`,
  page: (notebookId: string, pageId: string) => `pg:${notebookId}:${pageId}`,
};

/** Opens a doc, waits for local state (and, if online, the first sync up to `syncTimeoutMs`). */
export async function openLoaded(m: DocManager, docId: string, syncTimeoutMs = 0): Promise<DocHandle> {
  const h = m.open(docId);
  await h.loaded;
  const p = h.provider();
  if (p && syncTimeoutMs > 0) {
    await Promise.race([p.whenSynced(), new Promise((r) => setTimeout(r, syncTimeoutMs))]);
  }
  return h;
}
