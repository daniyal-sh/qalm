import { textHeight, type ImageItem, type TextItem } from '@qalm/core';

import { DEFAULT_TEXT_SIZE, DEFAULT_TEXT_WIDTH } from './items';

/**
 * Paste from other apps (web and Electron). The browser's `paste` event carries the system clipboard; qalm's own
 * Copy also writes a marker (a custom type, plus the text of any text boxes) so a later paste knows the system
 * clipboard still holds qalm's items.
 */
export const QALM_CLIP_TYPE = 'application/x-qalm-clip';

/** When the system clipboard may last have changed: a copy or cut that wasn't qalm's, or the window losing focus. */
let systemAt = 0;
let writing = false;

export const systemChangedAt = () => systemAt;

/** Starts noting system clipboard changes (web only). Returns the stop function. */
export function watchSystemClipboard(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;
  const changed = () => {
    if (!writing) systemAt = Date.now();
  };
  window.addEventListener('blur', changed);
  document.addEventListener('copy', changed, true);
  document.addEventListener('cut', changed, true);
  return () => {
    window.removeEventListener('blur', changed);
    document.removeEventListener('copy', changed, true);
    document.removeEventListener('cut', changed, true);
  };
}

/**
 * Puts qalm's marker (and `text`, so text boxes paste into other apps as text) on the system clipboard. Needs a
 * user gesture (Copy is always one); does nothing where there's no DOM or the browser refuses.
 */
export function writeClipMarker(id: string, text: string): void {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return;
  const onCopy = (ev: ClipboardEvent) => {
    if (!ev.clipboardData) return;
    ev.clipboardData.setData(QALM_CLIP_TYPE, id);
    if (text) ev.clipboardData.setData('text/plain', text);
    ev.preventDefault();
  };
  writing = true;
  document.addEventListener('copy', onCopy);
  try {
    document.execCommand('copy');
  } catch {
    // Not allowed here: the timestamps still decide.
  } finally {
    document.removeEventListener('copy', onCopy);
    writing = false;
  }
}

/** What a paste event offers from the system clipboard. */
export interface SystemClip {
  marker: string | null;
  image: Blob | null;
  text: string;
}

export function readPaste(dt: DataTransfer | null): SystemClip {
  if (!dt) return { marker: null, image: null, text: '' };
  let image: Blob | null = null;
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      image = it.getAsFile();
      if (image) break;
    }
  }
  return { marker: dt.getData(QALM_CLIP_TYPE) || null, image, text: dt.getData('text/plain') };
}

/**
 * What a paste should insert: qalm's own clip when the system clipboard holds qalm's marker, is empty, or changed
 * before the clip was set (`clipAt`, 0 when unknown, e.g. restored after a restart); the system image or text otherwise.
 */
export function pasteSource(sys: SystemClip, clipAt: number | null, changedAt: number): 'qalm' | 'image' | 'text' | null {
  const hasClip = clipAt !== null;
  if (hasClip && sys.marker) return 'qalm';
  const system = sys.image ? 'image' : sys.text.trim() ? 'text' : null;
  if (!system) return hasClip ? 'qalm' : null;
  return hasClip && clipAt > changedAt ? 'qalm' : system;
}

/** The centre of the part of a page that's in view, in page units (horizontally the page's centre). */
export function viewCentre(
  slot: { top: number; height: number },
  scrollY: number,
  viewportH: number,
  size: { w: number; h: number },
): { x: number; y: number } {
  const top = Math.max(slot.top, scrollY);
  const bottom = Math.min(slot.top + slot.height, scrollY + viewportH);
  const px = bottom > top ? (top + bottom) / 2 - slot.top : slot.height / 2;
  return { x: size.w / 2, y: (px * size.h) / slot.height };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A Markdown text box holding pasted text, centred on `at` and kept on the page. */
export function pastedText(text: string, at: { x: number; y: number }, size: { w: number; h: number }, color: string, id: string): TextItem {
  const clean = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  const w = Math.min(DEFAULT_TEXT_WIDTH * 1.5, size.w - 48);
  // A new box, so Markdown (`format: 'md'`) like a typed one.
  const base = { text: clean, w, fontSize: DEFAULT_TEXT_SIZE, format: 'md' as const };
  const h = textHeight(base);
  return { id, type: 'text', ...base, color, x: clamp(at.x - w / 2, 12, size.w - w - 12), y: clamp(at.y - h / 2, 12, Math.max(12, size.h - h - 12)) };
}

/** An image item for a pasted picture (natural size `px`, at most 60% of the page's width and height), centred on `at`. */
export function pastedImage(assetId: string, px: { w: number; h: number }, at: { x: number; y: number }, size: { w: number; h: number }, id: string): ImageItem {
  const nw = Math.max(1, px.w);
  const nh = Math.max(1, px.h);
  const k = Math.min(1, (size.w * 0.6) / nw, (size.h * 0.6) / nh);
  const w = nw * k;
  const h = nh * k;
  return { id, type: 'image', assetId, w, h, x: clamp(at.x - w / 2, 0, size.w - w), y: clamp(at.y - h / 2, 0, size.h - h) };
}
