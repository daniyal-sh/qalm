import type { Asset, Item } from '@qalm/core';
import * as React from 'react';

import { newId } from '../lib/id';
import { cloneItems } from './items';
import { writeClipMarker } from './systemPaste';

/** What Copy / Cut put on the in-app clipboard: the items, the assets their images need, and where they came from. */
export interface Clip {
  items: Item[];
  assets: Asset[];
  pageId: string;
  /** Marks the system clipboard as holding this clip (web and Electron: see `writeClipMarker`). */
  id?: string;
  /** Pastes so far onto the page they came from (each one lands a little further down and right). */
  pastes: number;
}

/** Offset between repeated pastes onto the source page (page units). */
export const PASTE_STEP = 16;

let clip: Clip | null = null;
/** When this run's Copy set the clip; 0 for one restored at startup (the system clipboard may have changed since). */
let clipAt = 0;
const subs = new Set<() => void>();

/** Where the clipboard is kept between runs (the app's kv store: per device). */
export interface ClipStore {
  get(): Promise<unknown>;
  set(clip: Clip): Promise<void>;
}
let store: ClipStore | null = null;

const save = () => {
  if (clip) store?.set(clip).catch(() => undefined);
};

/** A saved clip, if it still has the right shape (it was written by an older or newer build, maybe). */
function savedClip(v: unknown): Clip | null {
  const c = v as Partial<Clip> | null | undefined;
  if (!c || !Array.isArray(c.items) || !c.items.length || !Array.isArray(c.assets) || typeof c.pageId !== 'string') return null;
  if (!c.items.every((it) => it && typeof it === 'object' && typeof it.id === 'string' && typeof it.type === 'string')) return null;
  return { items: c.items, assets: c.assets, pageId: c.pageId, id: typeof c.id === 'string' ? c.id : undefined, pastes: Number.isFinite(c.pastes) ? c.pastes! : 0 };
}

/**
 * Keeps the clipboard across reloads and restarts: restores the saved clip (unless something was copied meanwhile)
 * and saves every later copy. Called once at startup.
 */
export async function persistClip(s: ClipStore): Promise<void> {
  store = s;
  const saved = savedClip(await s.get().catch(() => undefined));
  if (saved && !clip) {
    clip = saved;
    subs.forEach((f) => f());
  }
}

/** App-wide, so it works across pages and notebooks (and, with `persistClip`, across restarts). */
export function setClip(items: Item[], assets: Asset[], pageId: string): void {
  clip = { items: items.map((it) => ({ ...it })), assets, pageId, id: newId(), pastes: 0 };
  clipAt = Date.now();
  // Text boxes go out as plain text too, so they paste into other apps.
  writeClipMarker(clip.id!, items.flatMap((it) => (it.type === 'text' && it.text ? [it.text] : [])).join('\n\n'));
  save();
  subs.forEach((f) => f());
}

export function getClip(): Clip | null {
  return clip;
}

/** When the clip was set (see `clipAt`), or null when there is none. */
export function clipSetAt(): number | null {
  return clip ? clipAt : null;
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
  if (step && c === clip) save(); // the next paste after a restart keeps stepping
  return cloneItems(c.items, step, step, newId);
}
