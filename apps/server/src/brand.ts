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

export const BRAND_FONT_STACK = `Figtree, system-ui, -apple-system, 'Segoe UI', sans-serif`;

/** The qalm mark (assets/brand/qalm-mark.svg), inlined. */
export const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 100" fill="none" stroke-linecap="round" stroke-linejoin="round"> <defs><mask id="qalm-ring"><rect width="120" height="100" fill="#fff"/><path d="M60 94 C52 78 38 64 37 48 C36 34 46 22 60 11 C74 22 84 34 83 48 C82 64 68 78 60 94Z" fill="#000"/></mask></defs> <path d="M7.5 57.3L8.0 55.7L8.8 53.9L9.8 52.2L11.2 50.4L12.9 48.5L14.8 46.6L17.0 44.7L19.4 42.8L22.1 40.9L25.1 39.0L28.2 37.2L31.5 35.4L35.0 33.6L38.6 31.9L42.3 30.3L46.2 28.7L50.1 27.3L54.1 25.9L58.2 24.7L62.2 23.5L66.2 22.5L70.2 21.6L74.2 20.9L78.0 20.3L81.7 19.8L85.4 19.4L88.8 19.2L92.1 19.2L95.2 19.3L98.1 19.5L100.8 19.9L103.2 20.5L105.4 21.1L107.3 21.9L108.9 22.9L110.3 23.9" stroke="#4338CA" stroke-width="6" mask="url(#qalm-ring)"/> <path d="M60 86 C54 73 45 61 44 48 C43 37 50 28 60 19 C70 28 77 37 76 48 C75 61 66 73 60 86Z" stroke="#27272A" stroke-width="7"/> <path d="M60 80 L60 57" stroke="#27272A" stroke-width="5"/> <circle cx="60" cy="50" r="4.5" fill="#27272A"/> <path d="M111.2 24.9L112.0 26.3L112.5 27.9L112.6 29.6L112.3 31.4L111.6 33.3L110.5 35.3L109.0 37.4L107.1 39.5L104.9 41.6L102.4 43.8L99.5 46.0L96.3 48.1L92.8 50.2L89.1 52.3L85.2 54.3L81.1 56.2L76.8 58.1L72.4 59.8L67.9 61.4L63.3 62.9L58.7 64.2L54.1 65.4L49.6 66.4L45.1 67.2L40.8 67.9L36.6 68.4L32.6 68.7L28.8 68.8L25.2 68.7L21.9 68.5L18.9 68.0L16.2 67.4L13.8 66.6L11.8 65.6L10.1 64.4L8.8 63.1" stroke="#4338CA" stroke-width="6"/> <circle cx="107.3" cy="39.3" r="7.5" fill="#1D4ED8"/> </svg>`;
