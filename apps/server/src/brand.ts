/** Light-theme tokens from docs/brand.md (pages served by the worker). */
export const T = {
  bg: '#f3f3f5',
  surface: '#ffffff',
  surface2: '#f6f6f8',
  soft: '#e9e9ed',
  ink: '#27272a',
  ink2: '#3f3f46',
  muted: '#5c5c65',
  faint: '#8b8b95',
  line: '#d3d3d9',
  line2: '#e4e4e8',
  accent: '#4338ca',
  accentInk: '#3730a3',
  accentSoft: '#eeedfa',
  accentLine: '#c7c3ee',
  assistant: '#1d4ed8',
  assistantSoft: '#ebf0fc',
  assistantLine: '#bfcdf4',
  warn: '#9a4a08',
  warnSoft: '#f5ede6',
  bad: '#b91c1c',
  badSoft: '#f8e9e9',
} as const;

/** Dark-theme overrides. */
export const D = {
  bg: '#151517',
  surface: '#1c1c1f',
  surface2: '#212125',
  soft: '#2a2a2f',
  ink: '#f4f4f5',
  ink2: '#d4d4d8',
  muted: '#a1a1aa',
  faint: '#71717a',
  line: '#303035',
  line2: '#28282d',
  accent: '#5b50f0',
  accentInk: '#a9a3ff',
  accentSoft: '#26244a',
  accentLine: '#403b86',
  assistant: '#60a5fa',
  assistantSoft: '#1d2a3d',
  assistantLine: '#2f4b72',
  warn: '#fbbf24',
  warnSoft: '#332a17',
  bad: '#f87171',
  badSoft: '#351f20',
} as const;

/** The graphite app-icon tile. The app icon is always this tile with the dark mark (docs/brand.md, "Mark"). */
export const TILE = '#1c1c1f';

/**
 * The app icon as a PNG, for emails: Gmail and most clients show neither SVG nor data: images, so emails load it from
 * the site (apps/site/public/brand/qalm-icon-96.png, made by apps/site/landing/og.mjs), shown at 48 px.
 */
export const EMAIL_ICON_URL = 'https://qalm.apollolearn.app/brand/qalm-icon-96.png';

export const BRAND_FONT_STACK = `Figtree, system-ui, -apple-system, 'Segoe UI', sans-serif`;

/**
 * The qalm mark for dark surfaces (assets/brand/qalm-mark-dark.svg), inlined. The consent pages show it on the graphite
 * app-icon tile (`TILE`). Generated: `node assets/brand/build.mjs` rewrites this line.
 */
export const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="4.4 10.5 91.19 83" fill="none"><defs><mask id="qalm-mark-back" maskUnits="userSpaceOnUse" x="-0.6" y="5.5" width="101.19" height="93"><rect x="-0.6" y="5.5" width="101.19" height="93" fill="#fff"/><path d="M50 90 C44 76 33 65 33 51 C33 39 40 28 50 14 C60 28 67 39 67 51 C67 65 56 76 50 90Z" fill="#000"/><circle cx="87.61" cy="47.45" r="7.8" fill="#000"/></mask><mask id="qalm-mark-halo" maskUnits="userSpaceOnUse" x="-0.6" y="5.5" width="101.19" height="93"><rect x="-0.6" y="5.5" width="101.19" height="93" fill="#fff"/><circle cx="87.61" cy="47.45" r="7.8" fill="#000"/></mask></defs><path d="M92.29 36.61A45 15 -20 0 0 7.71 67.39" stroke="#7b72ff" stroke-width="5" stroke-linecap="round" mask="url(#qalm-mark-back)"/><path d="M50 90 C44 76 33 65 33 51 C33 39 40 28 50 14 C60 28 67 39 67 51 C67 65 56 76 50 90Z" stroke="#f4f4f5" stroke-width="6" stroke-linejoin="round"/><path d="M50 82V58" stroke="#f4f4f5" stroke-width="4.5" stroke-linecap="round"/><circle cx="50" cy="51" r="4.2" fill="#f4f4f5"/><path d="M7.71 67.39A45 15 -20 0 0 92.29 36.61" stroke="#7b72ff" stroke-width="5" stroke-linecap="round" mask="url(#qalm-mark-halo)"/><circle cx="87.61" cy="47.45" r="6.2" fill="#60a5fa"/></svg>`;
