import Foundation

/// Exactly `changedBounds` in src/inkDamage.ts (and InkDamage.kt): where two outlines of the same stroke differ
/// (traced as in `Freehand.path`, filled non-zero). Returns [minX, minY, maxX, maxY] in outline units, or nil when
/// they are the same. The live layer redraws only this box, so a move costs about the same at any stroke length.
enum InkDamage {
  static func changedBounds(_ prev: [FHVec], _ cur: [FHVec]) -> [Double]? {
    let a = prev.count
    let b = cur.count
    let m = min(a, b)
    func same(_ i: Int, _ j: Int) -> Bool { prev[i].x == cur[j].x && prev[i].y == cur[j].y }
    var head = 0
    while head < m && same(head, head) { head += 1 }
    if head == a && a == b { return nil }
    var tail = 0
    while tail < m - head && same(a - 1 - tail, b - 1 - tail) { tail += 1 }
    let lo = head - 2
    let hiA = a - tail + 1
    let hiB = b - tail + 1
    var box = [Double.infinity, Double.infinity, -Double.infinity, -Double.infinity]
    // stride, not `from...to`: an empty range (to < from) must be a no-op, as in the TS and Kotlin loops.
    func grow(_ pts: [FHVec], _ from: Int, _ to: Int) {
      for i in stride(from: from, through: to, by: 1) {
        let x = pts[i].x
        let y = pts[i].y
        if x < box[0] { box[0] = x }
        if y < box[1] { box[1] = y }
        if x > box[2] { box[2] = x }
        if y > box[3] { box[3] = y }
      }
    }
    // The change reaches the first or last point (the closing line), or a polygon too short to curve: all of both.
    if lo <= 0 || hiA >= a - 1 || hiB >= b - 1 || a < 4 || b < 4 {
      grow(prev, 0, a - 1)
      grow(cur, 0, b - 1)
    } else {
      grow(prev, lo, hiA)
      grow(cur, lo, hiB)
    }
    return box[0] <= box[2] ? box : nil
  }
}
