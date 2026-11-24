import { describe, expect, it } from 'vitest';
import { projectOnLine, rulerDegrees, rulerEdgeAt, rulerEdges, rulerLine, snapRulerAngle, snapToLine, RULER, type InkPoint, type RulerPose } from '../src';

const deg = (d: number) => (d * Math.PI) / 180;
const pose = (angle = 0): RulerPose => ({ cx: 400, cy: 300, angle, length: 600, thickness: 60 });

describe('ruler angles', () => {
  it('snaps to 0/45/90/… within 4°, else keeps the angle', () => {
    expect(snapRulerAngle(deg(3))).toBeCloseTo(0);
    expect(snapRulerAngle(deg(-3.5))).toBeCloseTo(0);
    expect(snapRulerAngle(deg(43))).toBeCloseTo(deg(45));
    expect(snapRulerAngle(deg(92))).toBeCloseTo(deg(90));
    expect(snapRulerAngle(deg(30))).toBeCloseTo(deg(30));
    expect(snapRulerAngle(deg(-30))).toBeCloseTo(deg(330));
    expect(RULER.snapDeg).toBe(4);
  });
  it('reads 0–179°', () => {
    expect(rulerDegrees(0)).toBe(0);
    expect(rulerDegrees(deg(45))).toBe(45);
    expect(rulerDegrees(deg(190))).toBe(10);
    expect(rulerDegrees(deg(-30))).toBe(150);
  });
});

describe('ruler edges', () => {
  it('has a top and a bottom edge, outward normals, at angle 0', () => {
    const [top, bottom] = rulerEdges(pose());
    expect(top.a).toEqual([100, 270]);
    expect(top.b).toEqual([700, 270]);
    expect(top.n[0]).toBeCloseTo(0);
    expect(top.n[1]).toBeCloseTo(-1);
    expect(bottom.a[1]).toBe(330);
    expect(bottom.n[1]).toBeCloseTo(1);
  });

  it('a stroke starting just outside an edge, or over its half, snaps to that edge; far away, none', () => {
    const r = pose();
    expect(rulerEdgeAt(r, [400, 255])?.a[1]).toBe(270); // 15 px above the top edge
    expect(rulerEdgeAt(r, [400, 290])?.a[1]).toBe(270); // over the top half
    expect(rulerEdgeAt(r, [400, 345])?.a[1]).toBe(330); // below the bottom edge
    expect(rulerEdgeAt(r, [400, 200])).toBeNull(); // too far above
    expect(rulerEdgeAt(r, [760, 260])).toBeNull(); // beyond its end
    expect(rulerEdgeAt(r, [715, 260])?.a[1]).toBe(270); // just past the end still counts
  });

  it('turned 90°, its edges are vertical', () => {
    const r = pose(deg(90));
    const e = rulerEdgeAt(r, [440, 300])!;
    expect(e.a[0]).toBeCloseTo(430);
    expect(e.b[0]).toBeCloseTo(430);
  });
});

describe('ruler projection', () => {
  it('projects onto the line, keeping pressure and time', () => {
    expect(projectOnLine([5, 9], [0, 0], [10, 0])).toEqual([5, 0]);
    const pts: InkPoint[] = [
      { x: 10, y: 3, p: 0.2, tilt: 1, az: 0, t: 0 },
      { x: 40, y: -2, p: 0.9, tilt: 1.2, az: 0.5, t: 16 },
    ];
    const s = snapToLine(pts, { a: [0, 0], b: [100, 0] });
    expect(s.map((q) => [q.x, q.y])).toEqual([[10, 0], [40, 0]]);
    expect(s.map((q) => [q.p, q.tilt, q.az, q.t])).toEqual([[0.2, 1, 0, 0], [0.9, 1.2, 0.5, 16]]);
  });

  it('the line in page units is the edge pushed out by half the pen width', () => {
    // A page drawn at 2 px per unit with its top-left at screen (100, 50).
    const toPage = ([x, y]: [number, number]): [number, number] => [(x - 100) / 2, (y - 50) / 2];
    const r = pose(deg(45));
    const e = rulerEdgeAt(r, [420, 280])!;
    const line = rulerLine(e, toPage, 1);
    const ea = toPage(e.a);
    const eb = toPage(e.b);
    // Parallel to the edge…
    expect(Math.atan2(line.b[1] - line.a[1], line.b[0] - line.a[0])).toBeCloseTo(Math.atan2(eb[1] - ea[1], eb[0] - ea[0]));
    // …one unit further out (away from the ruler's centre).
    const c = toPage([400, 300]);
    const dist = (p: [number, number], a: [number, number], b: [number, number]) => {
      const q = projectOnLine(p, a, b);
      return Math.hypot(p[0] - q[0], p[1] - q[1]);
    };
    expect(dist(c, line.a, line.b) - dist(c, ea, eb)).toBeCloseTo(1);
  });
});
