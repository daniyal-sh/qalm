import type { Item } from '../types';
import type { LectureEvent } from './types';

/** How a replay finds base ink (ink that was on the page before the session) that the timeline has no copy of. */
export type BaseLookup = (pageId: string, id: string) => Item | undefined;

interface PageState { items: Map<string, Item>; version: number }

/**
 * Replays a session's ink (docs/lecture-mode.md §2, §6): `at(t)` gives each page's items at time `t`. Base ink comes
 * from the earliest copy the timeline has (an `update`'s `before`, or the item an `erase` removed), else from `base`
 * (normally the page doc now). Moving forward applies only the new events; seeking back starts again from the base.
 */
export class LectureReplay {
  readonly events: LectureEvent[];
  readonly pages: string[];
  private initial = new Map<string, Map<string, Item>>();
  private state = new Map<string, PageState>();
  private next = 0;
  private cur = -Infinity;
  private snapshots = new Map<string, { version: number; items: Item[] }>();

  constructor(events: readonly LectureEvent[], base: BaseLookup) {
    this.events = [...events].sort((a, b) => a.t - b.t);
    const firstCopy = new Map<string, Item>();
    for (const e of this.events) {
      if (e.k === 'update' && e.before) for (const it of e.before) if (!firstCopy.has(it.id)) firstCopy.set(it.id, it);
      if (e.k === 'erase') for (const it of e.items) if (!firstCopy.has(it.id)) firstCopy.set(it.id, it);
      // An item added in the session isn't base ink: its add comes first.
      if (e.k === 'add') for (const it of e.items) if (!firstCopy.has(it.id)) firstCopy.set(it.id, null as unknown as Item);
    }
    const pages: string[] = [];
    for (const e of this.events) {
      if (e.k !== 'base' || this.initial.has(e.p)) continue;
      pages.push(e.p);
      const m = new Map<string, Item>();
      for (const id of e.ids) {
        const copy = firstCopy.get(id);
        const it = copy ?? (firstCopy.has(id) ? undefined : base(e.p, id));
        if (it) m.set(id, it);
      }
      this.initial.set(e.p, m);
    }
    for (const e of this.events) if ('p' in e && !this.initial.has(e.p)) {
      pages.push(e.p);
      this.initial.set(e.p, new Map());
    }
    this.pages = pages;
    this.reset();
  }

  private reset(): void {
    this.state = new Map([...this.initial].map(([p, m]) => [p, { items: new Map(m), version: (this.state.get(p)?.version ?? 0) + 1 }]));
    this.next = 0;
    this.cur = -Infinity;
  }

  /** The session's length (time of its last event). */
  get duration(): number {
    return this.events.length ? this.events[this.events.length - 1]!.t : 0;
  }

  private apply(e: LectureEvent): void {
    if (e.k !== 'add' && e.k !== 'erase' && e.k !== 'update') return;
    const st = this.state.get(e.p)!;
    // A partial erase adds a stroke's pieces (`splitFrom`) and erases the stroke in one transaction: the pieces take
    // the stroke's place in the z-order, as on the page (not on top of everything written since).
    const splits = e.k === 'add' ? e.items.filter((it) => splitOf(it) && st.items.has(splitOf(it)!) && !st.items.has(it.id)) : [];
    if (splits.length) {
      const after = new Map<string, Item[]>();
      for (const it of splits) after.set(splitOf(it)!, [...(after.get(splitOf(it)!) ?? []), it]);
      const next = new Map<string, Item>();
      for (const [id, it] of st.items) {
        next.set(id, it);
        for (const piece of after.get(id) ?? []) next.set(piece.id, piece);
      }
      st.items = next;
    }
    for (const it of e.items) {
      if (e.k === 'erase') st.items.delete(it.id);
      else st.items.set(it.id, it);
    }
    st.version++;
  }

  /** Each page's items at `t` (ms). Arrays are stable between calls while a page doesn't change. */
  at(t: number): Map<string, Item[]> {
    if (t < this.cur) this.reset();
    while (this.next < this.events.length && this.events[this.next]!.t <= t) this.apply(this.events[this.next++]!);
    this.cur = t;
    const out = new Map<string, Item[]>();
    for (const [p, st] of this.state) {
      let snap = this.snapshots.get(p);
      if (!snap || snap.version !== st.version) {
        snap = { version: st.version, items: [...st.items.values()] };
        this.snapshots.set(p, snap);
      }
      out.set(p, snap.items);
    }
    return out;
  }

  /** The page shown at `t` (the latest `page` event at or before it). */
  pageAt(t: number): string | null {
    let p: string | null = null;
    for (const e of this.events) {
      if (e.t > t) break;
      if (e.k === 'page') p = e.p;
    }
    return p ?? this.pages[0] ?? null;
  }
}

/** The stroke a piece came from (a partial erase), if it is one. */
const splitOf = (it: Item): string | undefined => (it as { splitFrom?: unknown }).splitFrom as string | undefined;

/**
 * When each item was written: its first `add` (not an undo or redo), minus the stroke's own length, so seeking there
 * plays the stroke from its first point. A piece a partial erase left (`splitFrom`) was written when its stroke was:
 * tapping it seeks there, not to the erase (pieces of pieces too). A piece of ink from before the session has no time.
 */
export function strokeTimes(events: readonly LectureEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  const pieces = new Set<string>();
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (e.k !== 'add' || e.by) continue;
    for (const it of e.items) {
      if (out.has(it.id) || pieces.has(it.id)) continue;
      const from = splitOf(it);
      if (from) {
        pieces.add(it.id);
        const t = out.get(from);
        if (t !== undefined) out.set(it.id, t);
        continue;
      }
      const len = it.type === 'stroke' && it.points.length ? it.points[it.points.length - 1]!.t : 0;
      out.set(it.id, Math.max(0, e.t - len));
    }
  }
  return out;
}
