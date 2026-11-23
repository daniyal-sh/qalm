/** qalm by Apollo tokens (docs/brand.md). Solid surfaces only; no gradients, blur or translucency. */
export const BRAND = {
  name: 'qalm',
  byline: 'by Apollo',
  website: 'https://apollolearn.app',
  systemName: 'qalm',
  appId: 'com.apollo.qalm',
} as const;

export interface Colors {
  bg: string;
  surface: string;
  surface2: string;
  soft: string;
  ink: string;
  ink2: string;
  muted: string;
  faint: string;
  line: string;
  line2: string;
  accent: string;
  accentInk: string;
  accentSoft: string;
  accentLine: string;
  assistant: string;
  assistantSoft: string;
  assistantLine: string;
  context: string;
  good: string;
  goodSoft: string;
  warn: string;
  warnSoft: string;
  bad: string;
  badSoft: string;
  /** text on solid accent / assistant fills */
  onAccent: string;
}

export const light: Colors = {
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
  context: '#0f766e',
  good: '#047857',
  goodSoft: '#e6f2ee',
  warn: '#9a4a08',
  warnSoft: '#f5ede6',
  bad: '#b91c1c',
  badSoft: '#f8e9e9',
  onAccent: '#ffffff',
};

export const dark: Colors = {
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
  context: '#5eccc4',
  good: '#34d399',
  goodSoft: '#1a2e27',
  warn: '#fbbf24',
  warnSoft: '#332a17',
  bad: '#f87171',
  badSoft: '#351f20',
  onAccent: '#ffffff',
};

export const radius = { control: 8, panel: 12, pill: 999 } as const;
export const CONTROL_H = 44;

export const shadow1 = {
  shadowColor: '#000',
  shadowOpacity: 0.04,
  shadowRadius: 2,
  shadowOffset: { width: 0, height: 1 },
  elevation: 1,
} as const;
/** Overlays only: popovers, sheets, the floating toolbar. */
export const shadow2 = {
  shadowColor: '#000',
  shadowOpacity: 0.22,
  shadowRadius: 20,
  shadowOffset: { width: 0, height: 18 },
  elevation: 8,
} as const;

export const font = {
  regular: 'Figtree_400Regular',
  medium: 'Figtree_500Medium',
  semibold: 'Figtree_600SemiBold',
  bold: 'Figtree_700Bold',
  mono: 'GeistMono_400Regular',
} as const;

/** Pen palette (brand.md). */
export const PEN_COLORS = [
  { name: 'Graphite', hex: '#27272a' },
  { name: 'Indigo', hex: '#4338ca' },
  { name: 'Blue', hex: '#1d4ed8' },
  { name: 'Teal', hex: '#0f766e' },
  { name: 'Red', hex: '#b91c1c' },
  { name: 'Amber', hex: '#b45309' },
] as const;
export const HIGHLIGHTER_COLORS = [
  { name: 'Yellow', hex: '#fde68a' },
  { name: 'Blue', hex: '#bfdbfe' },
  { name: 'Green', hex: '#bbf7d0' },
  { name: 'Pink', hex: '#fbcfe8' },
] as const;
/** Ink on night paper. */
export const NIGHT_INK = '#e4e4e7';

export const COVERS = [
  { name: 'Graphite', hex: '#27272a' },
  { name: 'Indigo', hex: '#4338ca' },
  { name: 'Blue', hex: '#1d4ed8' },
  { name: 'Teal', hex: '#0f766e' },
  { name: 'Sand', hex: '#d6c7a8' },
  { name: 'Rose', hex: '#c9a3a3' },
  { name: 'Sage', hex: '#a7b8a1' },
  { name: 'Paper', hex: '#f1efe9' },
] as const;

/** Text colour on a solid cover. */
export function coverInk(hex: string): string {
  const v = parseInt(hex.replace('#', ''), 16);
  const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#27272a' : '#ffffff';
}

export const PAPER_SWATCH = { white: '#ffffff', cream: '#fbf7ee', night: '#1f1f23' } as const;
