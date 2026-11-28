package app.qalm.ink

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/** InkDamage mirrors `changedBounds` (src/inkDamage.ts; apps/app/test/inkDamage.test.ts checks it pixel by pixel). */
class InkDamageTest {
  private fun handwriting(n: Int): List<InkPoint> = (0 until n).map { i ->
    val t = i / 240.0
    val w = 2 * PI * 2.1
    InkPoint(t * 55 + 3.5 * cos(w * t + PI) + 3.5, -6 * sin(w * t), 0.45 + 0.25 * sin(5 * t), PI / 2, 0.0, t * 1000)
  }

  private fun outline(pts: List<InkPoint>) = QalmFreehand.outline("pen", 1.8, pts, "fountain", 2)

  @Test
  fun sameOutlineIsNull() {
    val o = outline(handwriting(120))
    assertNull(InkDamage.changedBounds(o, o.map { it.copyOf() }))
    assertNull(InkDamage.changedBounds(emptyList(), emptyList()))
  }

  @Test
  fun growingStrokeDamagesOnlyNearThePen() {
    val all = handwriting(200)
    val prev = outline(all.subList(0, 196))
    val cur = outline(all)
    val box = InkDamage.changedBounds(prev, cur)
    assertNotNull(box)
    val tip = all.last()
    // The box is around the pen, a few units across, not the whole stroke (~45 units long).
    assertTrue("box ${box!!.toList()}", box[2] - box[0] < 12 && box[3] - box[1] < 14)
    assertTrue(tip.x >= box[0] - 2 && tip.x <= box[2] + 2 && tip.y >= box[1] - 2 && tip.y <= box[3] + 2)
  }

  @Test
  fun shortOrStartChangesDamageEverything() {
    val a = outline(handwriting(2))
    val b = outline(handwriting(3))
    val box = InkDamage.changedBounds(a, b)!!
    val all = (a + b)
    assertArrayEquals(
      doubleArrayOf(all.minOf { it[0] }, all.minOf { it[1] }, all.maxOf { it[0] }, all.maxOf { it[1] }),
      box,
      0.0,
    )
  }
}
