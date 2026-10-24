package gg.vlm.spaces.builder

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DraftThrottleTest {
  private var t = 0L
  private val throttle = DraftThrottle({ t })

  @Test
  fun `lets at most ten a second through per item`() {
    var sent = 0
    for (i in 0 until 1000) {
      if (throttle.allow("a")) sent++
      t += 1
    }
    assertEquals(10, sent)
  }

  @Test
  fun `a hundred milliseconds apart is allowed, sooner is not`() {
    assertTrue(throttle.allow("a"))
    t += 99
    assertFalse(throttle.allow("a"))
    t += 1
    assertTrue(throttle.allow("a"))
  }

  @Test
  fun `items are throttled separately and reset lets the next one out`() {
    assertTrue(throttle.allow("a"))
    assertTrue(throttle.allow("b"))
    assertFalse(throttle.allow("a"))
    throttle.reset("a")
    assertTrue(throttle.allow("a"))
  }

  @Test
  fun `a draft turned away comes due once the gap has passed`() {
    assertTrue(throttle.allow("a"))
    t += 30
    assertFalse(throttle.allow("a"))
    assertTrue(throttle.due().isEmpty())
    t += 70
    assertEquals(listOf("a"), throttle.due())
    assertTrue("sent once", throttle.due().isEmpty())
    t += 50
    assertFalse("the due send counts as sent", throttle.allow("a"))
  }

  @Test
  fun `flush lets a held-back draft out at once, and only if there is one`() {
    assertTrue(throttle.allow("a"))
    assertFalse(throttle.flush("a"))
    t += 10
    assertFalse(throttle.allow("a"))
    assertTrue(throttle.flush("a"))
    assertFalse(throttle.flush("a"))
    assertTrue(throttle.due().isEmpty())
  }

  @Test
  fun `a later allowed send clears the held-back draft, and reset drops it`() {
    assertTrue(throttle.allow("a"))
    t += 10
    assertFalse(throttle.allow("a"))
    t += 100
    assertTrue(throttle.allow("a"))
    assertTrue(throttle.due().isEmpty())
    t += 10
    assertFalse(throttle.allow("a"))
    throttle.reset("a")
    assertTrue(throttle.due().isEmpty())
  }
}
