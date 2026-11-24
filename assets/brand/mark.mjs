// The qalm mark ("A, nib in orbit, refined"; mockups/logo-options.html) as plain SVG, in one place.
// Every consumer that can import ES modules builds from here (desktop and app icons, the site); the rest inline the
// generated files (`node assets/brand/build.mjs` writes them next to this file).
//
// Construction (in a 100-unit design grid): a nib outline with a slit and a breather hole; Apollo's orbit, an ellipse
// tilted -20°, passes BEHIND the nib at the top and IN FRONT of it at the bottom; Apollo's planet rides the front of the
// ring with a halo around it. There is no occluder fill and no halo stroke: the back arc is cut by a <mask> where the
// nib covers it, and the front arc is cut by a <mask> around the planet. So the mark is transparent everywhere but its
// ink and works on any background without recolouring.

/** Colour sets. `light` is for light surfaces, `dark` for dark surfaces and the graphite app-icon tile. */
export const COLORS = {
  light: { ink: '#27272a', orbit: '#4338ca', planet: '#1d4ed8' },
  dark: { ink: '#f4f4f5', orbit: '#7b72ff', planet: '#60a5fa' },
};

/** The graphite app-icon tile (brand dark `surface`). The app icon is always this tile with the dark mark. */
export const TILE = '#1c1c1f';

/**
 * Stroke weights, tuned by rendering the icon at 16, 24 and 32 px (see docs/brand.md, "Small sizes").
 * - `regular`: the mockup's drawing, for anything drawn larger than 24 px.
 * - `small` (17–24 px): heavier nib (8) and orbit (7), bigger hole and planet, so the ring doesn't fade into the tile.
 * - `tiny` (16 px and below): heavier still, and the breather hole is dropped: at 16 px it merged with the slit into
 *   a grey blob, while a clean slit still reads as a nib.
 */
export const WEIGHTS = {
  regular: { nib: 6, orbit: 5, slit: 4.5, hole: 4.2, planet: 6.2, halo: 1.6 },
  small: { nib: 8, orbit: 7, slit: 5.5, hole: 5.2, planet: 8.4, halo: 1.8 },
  tiny: { nib: 9, orbit: 7.5, slit: 6, hole: 0, planet: 10, halo: 2 },
};

/** The weight to draw at `px` (the mark's or the icon's rendered size). */
export const weightFor = (px) => (px <= 16 ? 'tiny' : px <= 24 ? 'small' : 'regular');
/** The mark's share of the icon tile at `px`: 72% normally, 82% at 32 px and below so the mark fills a favicon. */
export const iconScaleFor = (px) => (px <= 32 ? 0.82 : 0.72);

// Geometry, in the 100-unit grid.
const C = { x: 50, y: 52 }; // orbit centre
const RX = 45;
const RY = 15;
const TILT = -20; // degrees
export const NIB = 'M50 90 C44 76 33 65 33 51 C33 39 40 28 50 14 C60 28 67 39 67 51 C67 65 56 76 50 90Z';
const SLIT = { x: 50, y1: 82, y2: 58 };
const HOLE = { x: 50, y: 51 };
const PLANET_T = 0.82; // planet on the front arc: the point at ellipse-frame (86.9, 60.6), as in the mockup

const r = (n) => Math.round(n * 100) / 100;
const rad = (TILT * Math.PI) / 180;
/** A point in the ellipse's own (untilted) frame, rotated into the design grid. */
function rot(x, y) {
  const dx = x - C.x;
  const dy = y - C.y;
  return [C.x + dx * Math.cos(rad) - dy * Math.sin(rad), C.y + dx * Math.sin(rad) + dy * Math.cos(rad)];
}
const L = rot(C.x - RX, C.y);
const R = rot(C.x + RX, C.y);
const arc = (from, to) => `M${r(from[0])} ${r(from[1])}A${RX} ${RY} ${TILT} 0 0 ${r(to[0])} ${r(to[1])}`;
/** Front (bottom) half: left end → bottom → right end. Back (top) half: right end → top → left end. */
export const ORBIT_FRONT = arc(L, R);
export const ORBIT_BACK = arc(R, L);
const pt = rot(C.x + RX * PLANET_T, C.y + RY * Math.sqrt(1 - PLANET_T * PLANET_T));
export const PLANET = { cx: r(pt[0]), cy: r(pt[1]) };

/** The ink's bounds (plus a hair of padding), so the viewBox is tight. Computed, not guessed. */
export function bounds(w = WEIGHTS.regular) {
  // Tilted ellipse half-extents, plus half the orbit stroke.
  const ex = Math.sqrt(RX ** 2 * Math.cos(rad) ** 2 + RY ** 2 * Math.sin(rad) ** 2) + w.orbit / 2;
  const ey = Math.sqrt(RX ** 2 * Math.sin(rad) ** 2 + RY ** 2 * Math.cos(rad) ** 2) + w.orbit / 2;
  const minX = Math.min(C.x - ex, 33 - w.nib / 2);
  const maxX = Math.max(C.x + ex, PLANET.cx + w.planet);
  const minY = Math.min(C.y - ey, 14 - w.nib / 2);
  const maxY = Math.max(C.y + ey, 90 + w.nib / 2);
  const p = 0.5;
  return { x: r(minX - p), y: r(minY - p), w: r(maxX - minX + 2 * p), h: r(maxY - minY + 2 * p) };
}

/**
 * The mark's inner SVG (no <svg> wrapper). `id` prefixes the two mask ids, so one page can show the mark twice.
 * `classes: true` adds class="orbit|nib|nibfill|planet" for pages that colour it with CSS tokens.
 */
export function markInner({ colors = COLORS.light, weight = 'regular', id = 'qalm', classes = false } = {}) {
  const w = WEIGHTS[weight];
  const b = bounds(w);
  const big = `x="${r(b.x - 5)}" y="${r(b.y - 5)}" width="${r(b.w + 10)}" height="${r(b.h + 10)}"`;
  const k = (name) => (classes ? ` class="${name}"` : '');
  const halo = `<circle cx="${PLANET.cx}" cy="${PLANET.cy}" r="${r(w.planet + w.halo)}" fill="#000"/>`;
  return [
    `<defs>`,
    // Back arc: hidden inside the nib (the nib outline is drawn over the cut) and around the planet.
    `<mask id="${id}-back" maskUnits="userSpaceOnUse" ${big}><rect ${big} fill="#fff"/><path d="${NIB}" fill="#000"/>${halo}</mask>`,
    // Front arc: a gap around the planet (the halo), `halo` wide.
    `<mask id="${id}-halo" maskUnits="userSpaceOnUse" ${big}><rect ${big} fill="#fff"/>${halo}</mask>`,
    `</defs>`,
    `<path${k('orbit')} d="${ORBIT_BACK}" stroke="${colors.orbit}" stroke-width="${w.orbit}" stroke-linecap="round" mask="url(#${id}-back)"/>`,
    `<path${k('nib')} d="${NIB}" stroke="${colors.ink}" stroke-width="${w.nib}" stroke-linejoin="round"/>`,
    `<path${k('nib')} d="M${SLIT.x} ${SLIT.y1}V${SLIT.y2}" stroke="${colors.ink}" stroke-width="${w.slit}" stroke-linecap="round"/>`,
    w.hole ? `<circle${k('nibfill')} cx="${HOLE.x}" cy="${HOLE.y}" r="${w.hole}" fill="${colors.ink}"/>` : '',
    `<path${k('orbit')} d="${ORBIT_FRONT}" stroke="${colors.orbit}" stroke-width="${w.orbit}" stroke-linecap="round" mask="url(#${id}-halo)"/>`,
    `<circle${k('planet')} cx="${PLANET.cx}" cy="${PLANET.cy}" r="${w.planet}" fill="${colors.planet}"/>`,
  ].join('');
}

/** A standalone mark SVG with a viewBox tight to its ink. */
export function markSvg(opts = {}) {
  const b = bounds(WEIGHTS[opts.weight ?? 'regular']);
  const attrs = opts.attrs ?? 'xmlns="http://www.w3.org/2000/svg"';
  return `<svg ${attrs} viewBox="${b.x} ${b.y} ${b.w} ${b.h}" fill="none">${markInner(opts)}</svg>`;
}

/**
 * The app icon: the graphite tile with the dark mark centred at `scale` of the tile's width.
 * `size` is the canvas (default 1024); `tile` the tile's side inside it (default: full bleed); `radius` its corner radius
 * as a fraction of the tile (0 = square, for platforms that mask the icon themselves). `weight: 'small'` for ≤ 24 px.
 */
export function iconSvg({ size = 1024, tile = size, radius = 0, scale = 0.72, weight = 'regular', id = 'qalm', bg = TILE } = {}) {
  const w = WEIGHTS[weight];
  const b = bounds(w);
  const o = (size - tile) / 2;
  const mw = tile * scale;
  const k = mw / b.w;
  const mh = b.h * k;
  // Centre the ink's box.
  const x = size / 2 - mw / 2;
  const y = size / 2 - mh / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    `<rect x="${r(o)}" y="${r(o)}" width="${r(tile)}" height="${r(tile)}" rx="${r(tile * radius)}" fill="${bg}"/>` +
    `<svg x="${r(x)}" y="${r(y)}" width="${r(mw)}" height="${r(mh)}" viewBox="${b.x} ${b.y} ${b.w} ${b.h}" fill="none">` +
    markInner({ colors: COLORS.dark, weight, id }) +
    `</svg></svg>`;
}
