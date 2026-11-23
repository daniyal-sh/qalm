import type * as Y from 'yjs';

interface Entry {
  pageId: string;
  /** Number of page-level undo steps this entry covers (merged erase strokes, etc.). */
  steps: number;
  mergeKey?: string;
  at: number;
}

interface StackItemAddedEvent {
  type: 'undo' | 'redo';
  origin: unknown;
}

/**
 * The per-device cross-page undo stack (tech-spec §2): each page has its own `createUndoManager`,
 * and this stack remembers which page each local edit went to, so undo/redo goes to the right page.
 * Edits from other devices and agents never reach a page's UndoManager, so they are never undone.
 */
export class CrossPageUndo {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private managers = new Map<string, Y.UndoManager>();
  private detachers = new Map<string, () => void>();
  private listeners = new Set<() => void>();
  private merge: { key: string; windowMs: number } | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  get canUndo(): boolean {
    return this.undoStack.some((e) => this.managers.has(e.pageId));
  }

  get canRedo(): boolean {
    return this.redoStack.some((e) => this.managers.has(e.pageId));
  }

  /** Starts tracking a page's UndoManager. Re-attaching the same page replaces the old manager. */
  attach(pageId: string, um: Y.UndoManager): () => void {
    this.detach(pageId);
    const onAdded = (ev: StackItemAddedEvent) => {
      // A redo performed by the manager itself also adds an 'undo' item; we track those ourselves.
      if (ev.type !== 'undo' || ev.origin === um) return;
      this.record(pageId);
    };
    um.on('stack-item-added', onAdded);
    this.managers.set(pageId, um);
    const off = () => {
      um.off('stack-item-added', onAdded);
      if (this.managers.get(pageId) === um) this.managers.delete(pageId);
      this.detachers.delete(pageId);
    };
    this.detachers.set(pageId, off);
    this.emit();
    return off;
  }

  /** Stops tracking a page (doc evicted). Its entries are skipped from now on. */
  detach(pageId: string): void {
    this.detachers.get(pageId)?.();
    this.undoStack = this.undoStack.filter((e) => e.pageId !== pageId);
    this.redoStack = this.redoStack.filter((e) => e.pageId !== pageId);
    this.emit();
  }

  /**
   * Runs `fn`; edits it makes on the same page within `windowMs` of the previous edit with the same
   * key join one undo entry (e.g. the many segments of one eraser gesture).
   */
  merging<T>(key: string, fn: () => T, windowMs = 600): T {
    const prev = this.merge;
    this.merge = { key, windowMs };
    try {
      return fn();
    } finally {
      this.merge = prev;
    }
  }

  private record(pageId: string): void {
    const at = this.now();
    const top = this.undoStack[this.undoStack.length - 1];
    const m = this.merge;
    if (m && top && top.pageId === pageId && top.mergeKey === m.key && at - top.at <= m.windowMs) {
      top.steps++;
      top.at = at;
    } else {
      this.undoStack.push({ pageId, steps: 1, mergeKey: m?.key, at });
      if (this.undoStack.length > 200) this.undoStack.shift();
    }
    this.redoStack = [];
    this.emit();
  }

  /** Undoes the latest local edit on whichever page it was. Returns that page id. */
  undo(): string | null {
    while (this.undoStack.length) {
      const e = this.undoStack.pop()!;
      const um = this.managers.get(e.pageId);
      if (!um) continue;
      let done = 0;
      for (let i = 0; i < e.steps; i++) if (um.undo()) done++;
      if (done === 0) continue;
      this.redoStack.push({ ...e, steps: done, mergeKey: undefined });
      this.emit();
      return e.pageId;
    }
    this.emit();
    return null;
  }

  redo(): string | null {
    while (this.redoStack.length) {
      const e = this.redoStack.pop()!;
      const um = this.managers.get(e.pageId);
      if (!um) continue;
      let done = 0;
      for (let i = 0; i < e.steps; i++) if (um.redo()) done++;
      if (done === 0) continue;
      this.undoStack.push({ ...e, steps: done, mergeKey: undefined, at: this.now() });
      this.emit();
      return e.pageId;
    }
    this.emit();
    return null;
  }

  clear(): void {
    for (const off of [...this.detachers.values()]) off();
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }
}
