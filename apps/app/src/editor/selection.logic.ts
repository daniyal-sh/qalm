import { mapFrame, selectionFrame, type Frame, type Item, type Sim, type TextItem } from '@qalm/core';

/** A selection edit in progress: a transform of every selected item, or a text box's new width. */
export type LiveEdit = { kind: 'sim'; sim: Sim } | { kind: 'text'; id: string; patch: Pick<TextItem, 'x' | 'y' | 'w'> };

/** The frame shown for the selection: its items' frame, with the live edit applied. */
export function liveFrame(items: Item[], live: LiveEdit | null): Frame | null {
  if (live?.kind === 'text') return selectionFrame(items.map((it) => (it.id === live.id ? ({ ...it, ...live.patch } as Item) : it)));
  const f = selectionFrame(items);
  return f && live?.kind === 'sim' ? mapFrame(f, live.sim) : f;
}
