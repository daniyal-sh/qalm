import type { InkPoint } from './types';

const FIELDS = 6;
const STRIDE = FIELDS * 4;

/** Packs points as little-endian Float32 6-tuples (x, y, p, tilt, az, t). */
export function encodePoints(points: InkPoint[]): Uint8Array {
  const out = new Uint8Array(points.length * STRIDE);
  const dv = new DataView(out.buffer);
  points.forEach((q, i) => {
    const o = i * STRIDE;
    dv.setFloat32(o, q.x, true);
    dv.setFloat32(o + 4, q.y, true);
    dv.setFloat32(o + 8, q.p, true);
    dv.setFloat32(o + 12, q.tilt, true);
    dv.setFloat32(o + 16, q.az, true);
    dv.setFloat32(o + 20, q.t, true);
  });
  return out;
}

export function decodePoints(bytes: Uint8Array): InkPoint[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.floor(bytes.byteLength / STRIDE);
  const out: InkPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * STRIDE;
    out[i] = {
      x: dv.getFloat32(o, true),
      y: dv.getFloat32(o + 4, true),
      p: dv.getFloat32(o + 8, true),
      tilt: dv.getFloat32(o + 12, true),
      az: dv.getFloat32(o + 16, true),
      t: dv.getFloat32(o + 20, true),
    };
  }
  return out;
}
