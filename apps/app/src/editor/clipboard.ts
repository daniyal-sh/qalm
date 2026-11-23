import type { Asset, Item } from '@qalm/core';
import * as React from 'react';

import { cloneItems } from './items';

/** What Copy / Cut put on the in-app clipboard: the items, the assets their images need, and where they came from. */
export interface Clip {
  items: Item[];
  assets: Asset[];
  pageId: string;
  /** Pastes so far onto the page they came from (each one lands a little further down and right). */
  pastes: number;
}

/** Offset between repeated pastes onto the source page (page units). */
export const PASTE_STEP = 16;

let clip: Clip | null = null;
const subs = new Set<() => void>();

/** App-wide, so it works across pages and notebooks while the app runs. */
export function setClip(items: Item[], assets: Asset[], pageId: string): void {
  clip = { items: items.map((it) => ({ ...it })), assets, pageId, pastes: 0 };
  subs.forEach((f) => f());
}

export function getClip(): Clip | null {
  return clip;
}

export function useClip(): Clip | null {
  return React.useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
    getClip,
    getClip,
  );
}

/**
 * Fresh copies of the clipboard for `pageId`, with new ids: in place on another page (or notebook), stepped down
 * and right on the page they came from so a paste never hides under its original.
 */
export function pasteItems(c: Clip, pageId: string, newId: () => string): Item[] {
  const step = c.pageId === pageId ? (++c.pastes) * PASTE_STEP : 0;
  return cloneItems(c.items, step, step, newId);
}
