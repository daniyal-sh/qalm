import * as Y from 'yjs';
import { LOCAL_ORIGIN } from '../origin';
import type { Page } from '../model/page';
import type { Item } from '../types';
import type { LectureEvent } from './types';

type ItemEvent = Extract<LectureEvent, { k: 'add' | 'erase' | 'update' }>;

/**
 * The ink log of a recording session (docs/lecture-mode.md §2). Attach each page doc the editor opens; every **local**
 * transaction (this device's edits, undo and redo) becomes `add` / `erase` / `update` events stamped with the session
 * clock. Remote changes (other devices, agents) are not logged. The first time the session sees a page it logs a `base`
 * event: the ids of the ink already there.
 */
export class LectureLog {
  /** Pages that already have a `base` event in this session. */
  private based = new Set<string>();
  /** Items whose full content the timeline already carries (added, erased or `before`d in this session). */
  private known = new Set<string>();
  private enabled = true;

  constructor(
    private readonly clock: () => number,
    private readonly emit: (e: LectureEvent) => void,
  ) {}

  /** While paused the pen is locked; anything that still changes (none expected) isn't logged. */
  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  /** Starts logging a page doc; returns the detach function. Safe to call again for the same page later. */
  attach(pageId: string, page: Page): () => void {
    const cache = new Map<string, Item>(page.items().map((it) => [it.id, it]));
    if (!this.based.has(pageId)) {
      this.based.add(pageId);
      this.emit({ t: this.clock(), k: 'base', p: pageId, ids: [...cache.keys()] });
    }
    const itemMap = page.doc.getMap('items');
    const onTx = (tx: Y.Transaction) => {
      const origin = tx.origin;
      const undo = origin instanceof Y.UndoManager;
      const changed = new Set<string>();
      for (const [type, keys] of tx.changed) {
        if ((type as unknown) === itemMap) {
          for (const k of keys) if (k) changed.add(k);
          continue;
        }
        // A field of an existing item changed: its id is the key it sits under in `items`.
        const it = type._item;
        if (it && (it.parent as unknown) === itemMap && typeof it.parentSub === 'string') changed.add(it.parentSub);
      }
      if (!changed.size) return;
      const local = origin === LOCAL_ORIGIN || undo;
      if (!local || !this.enabled) {
        // Keep the cache current so a later local edit diffs against what is really there.
        for (const id of changed) {
          const now = page.item(id);
          if (now) cache.set(id, now);
          else cache.delete(id);
        }
        return;
      }
      const by: ItemEvent['by'] = undo ? ((origin as Y.UndoManager).redoing ? 'redo' : 'undo') : undefined;
      const added: Item[] = [], erased: Item[] = [], updated: Item[] = [], before: Item[] = [];
      for (const id of changed) {
        const was = cache.get(id);
        const now = page.item(id);
        if (now && !was) added.push(now);
        else if (!now && was) erased.push(was);
        else if (now && was && now !== was) {
          updated.push(now);
          if (!this.known.has(id)) before.push(was);
        }
        if (now) cache.set(id, now);
        else cache.delete(id);
      }
      const t = this.clock();
      const extra = by ? { by } : {};
      if (added.length) this.emit({ t, k: 'add', p: pageId, items: added, ...extra });
      if (updated.length) this.emit({ t, k: 'update', p: pageId, items: updated, ...(before.length ? { before } : {}), ...extra });
      if (erased.length) this.emit({ t, k: 'erase', p: pageId, items: erased, ...extra });
      for (const it of [...added, ...updated, ...erased]) this.known.add(it.id);
    };
    page.doc.on('afterTransaction', onTx);
    return () => page.doc.off('afterTransaction', onTx);
  }
}
