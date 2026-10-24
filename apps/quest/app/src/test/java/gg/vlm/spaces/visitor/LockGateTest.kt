package gg.vlm.spaces.visitor

import org.junit.Assert.assertEquals
import org.junit.Test

class LockGateTest {
  @Test fun `too few frames is gathering`() =
      assertEquals(Gate.GATHERING, LockGate.evaluate(4, 0.004, 0.5, 1.2))

  @Test fun `far away is too far`() = assertEquals(Gate.TOO_FAR, LockGate.evaluate(5, 0.004, 0.5, 1.6))

  @Test fun `close and still is steady`() = assertEquals(Gate.STEADY, LockGate.evaluate(5, 0.004, 0.5, 1.2))

  @Test fun `wide position spread is gathering`() =
      assertEquals(Gate.GATHERING, LockGate.evaluate(5, 0.02, 0.5, 1.2))

  @Test fun `wide heading spread is gathering`() =
      assertEquals(Gate.GATHERING, LockGate.evaluate(5, 0.004, 2.0, 1.2))

  @Test fun `non-finite inputs are gathering`() {
    assertEquals(Gate.GATHERING, LockGate.evaluate(5, Double.NaN, 0.5, 1.2))
    assertEquals(Gate.GATHERING, LockGate.evaluate(5, 0.004, Double.NaN, 1.2))
    assertEquals(Gate.GATHERING, LockGate.evaluate(5, 0.004, 0.5, Double.NaN))
    assertEquals(Gate.GATHERING, LockGate.evaluate(5, 0.004, 0.5, Double.POSITIVE_INFINITY))
  }
}
