/**
 * Scrollbars on web and Electron: slim, with a transparent track, and a thumb that only shows while the pointer is over
 * the scrolling area (so a page scroller's bar never reads as a divider between the page and a panel). Native keeps the
 * platform's own overlay indicators (`indicatorStyle` follows the theme).
 */
import type { Colors } from './tokens';

/** The thumb colour while its scroller is hovered (solid, on brand: a step above `line`). */
export function scrollbarThumb(scheme: 'light' | 'dark'): string {
  return scheme === 'dark' ? '#4a4a52' : '#c2c2ca';
}

/** The global stylesheet for `scheme`. Standard properties first; `::-webkit-scrollbar` only where they're missing (Safari). */
export function scrollbarCss(scheme: 'light' | 'dark', c: Pick<Colors, 'muted'>): string {
  const thumb = scrollbarThumb(scheme);
  return [
    // Native form controls and any scrollbar the rules below miss follow the theme (no white track in dark mode).
    `:root { color-scheme: ${scheme}; }`,
    `@supports (scrollbar-color: auto) {`,
    `  * { scrollbar-width: thin; scrollbar-color: transparent transparent; }`,
    `  *:hover { scrollbar-color: ${thumb} transparent; }`,
    `}`,
    `@supports not (scrollbar-color: auto) {`,
    `  ::-webkit-scrollbar { width: 10px; height: 10px; background: transparent; }`,
    `  ::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }`,
    `  ::-webkit-scrollbar-thumb { background-color: transparent; border-radius: 999px; border: 3px solid transparent; background-clip: content-box; }`,
    `  *:hover::-webkit-scrollbar-thumb { background-color: ${thumb}; }`,
    `  ::-webkit-scrollbar-thumb:hover { background-color: ${c.muted}; }`,
    `}`,
  ].join('\n');
}

const STYLE_ID = 'qalm-scrollbars';

/** Installs (or updates) the stylesheet on web; a no-op on native. */
export function applyWebScrollbars(scheme: 'light' | 'dark', c: Pick<Colors, 'muted'>): void {
  // Native has no DOM (and keeps its own indicators).
  if (typeof document === 'undefined' || !document.head) return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  const css = scrollbarCss(scheme, c);
  if (el.textContent !== css) el.textContent = css;
}

/** iOS scroll indicator style for the theme (Android's are already subtle and theme-neutral). */
export const indicatorStyleFor = (scheme: 'light' | 'dark') => (scheme === 'dark' ? ('white' as const) : ('black' as const));
