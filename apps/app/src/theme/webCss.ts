/**
 * Global stylesheet on web and Electron (native has no DOM): keyboard focus rings, reduced motion, text rendering and
 * the text-selection colour. Scrollbars live in `scrollbars.ts`.
 */
import type { Colors } from './tokens';

export function globalCss(c: Pick<Colors, 'accent' | 'accentLine' | 'accentSoft' | 'ink'>): string {
  return [
    `html, body { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; }`,
    `body { -webkit-tap-highlight-color: transparent; }`,
    `::selection { background: ${c.accentSoft}; color: ${c.ink}; }`,
    // Focus rings only for keyboard focus (brand.md: 2px accent-line plus a 1px accent edge), never after a click or tap.
    `[tabindex]:focus-visible, button:focus-visible, a:focus-visible, [role="button"]:focus-visible, [role="switch"]:focus-visible, [role="radio"]:focus-visible, [role="menuitem"]:focus-visible {`,
    `  outline: 2px solid ${c.accentLine}; outline-offset: 1px; box-shadow: inset 0 0 0 1px ${c.accent};`,
    `}`,
    `[tabindex]:focus:not(:focus-visible) { outline: none; }`,
    // Text fields draw their own focused border.
    `input:focus-visible, textarea:focus-visible { outline: none; box-shadow: none; }`,
    `@media (prefers-reduced-motion: reduce) {`,
    `  *, *::before, *::after { transition-duration: 0ms !important; animation-duration: 0ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; }`,
    `}`,
  ].join('\n');
}

const STYLE_ID = 'qalm-global';

/** Installs (or updates) the stylesheet on web; a no-op on native. */
export function applyWebGlobals(c: Pick<Colors, 'accent' | 'accentLine' | 'accentSoft' | 'ink'>): void {
  if (typeof document === 'undefined' || !document.head) return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  const text = globalCss(c);
  if (el.textContent !== text) el.textContent = text;
}
