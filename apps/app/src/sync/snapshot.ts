import * as Y from 'yjs';

/** Byte storage keyed by name (native: files; tests: memory). */
export interface BytesStorage {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
  list?(): Promise<string[]>;
}

/** Local persistence of one doc, whatever the backend. */
export interface DocPersistence {
  /** Resolves once stored state has been applied to the doc. */
  readonly whenSynced: Promise<void>;
  /** Writes pending changes now. */
  flush(): Promise<void>;
  /** Flushes and detaches from the doc. */
  destroy(): Promise<void>;
}

/**
 * Persists a doc as one encoded state snapshot, written a short while after each change
 * (and on flush/destroy). Small and robust: a page doc is a few KB to a few hundred KB.
 */
export class SnapshotPersistence implements DocPersistence {
  readonly whenSynced: Promise<void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();
  private destroyed = false;
  private readonly onUpdate = (_u: Uint8Array, origin: unknown) => {
    if (origin === this) return;
    this.dirty = true;
    this.schedule();
  };

  constructor(
    private readonly name: string,
    private readonly doc: Y.Doc,
    private readonly storage: BytesStorage,
    private readonly debounceMs = 400,
  ) {
    this.whenSynced = (async () => {
      const bytes = await storage.read(name);
      if (bytes && bytes.length > 0 && !this.destroyed) Y.applyUpdate(doc, bytes, this);
    })();
    doc.on('update', this.onUpdate);
  }

  private schedule(): void {
    if (this.timer || this.destroyed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.writing = this.writing.then(async () => {
      await this.whenSynced.catch(() => undefined);
      if (!this.dirty) return;
      this.dirty = false;
      await this.storage.write(this.name, Y.encodeStateAsUpdate(this.doc));
    });
    return this.writing;
  }

  async destroy(): Promise<void> {
    this.doc.off('update', this.onUpdate);
    await this.flush();
    this.destroyed = true;
  }
}

export class MemoryStorage implements BytesStorage {
  readonly data = new Map<string, Uint8Array>();
  async read(name: string) {
    return this.data.get(name) ?? null;
  }
  async write(name: string, bytes: Uint8Array) {
    this.data.set(name, bytes.slice());
  }
  async remove(name: string) {
    this.data.delete(name);
  }
  async list() {
    return [...this.data.keys()];
  }
}
