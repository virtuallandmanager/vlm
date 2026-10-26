package io.virvi.ar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SceneFadeTest {
  private val f = SceneFade(fadeMs = 400)

  @Test fun `starts hidden`() {
    assertEquals(0f, f.alpha)
    assertFalse(f.mediaOn)
    assertFalse(f.solidOn)
  }

  @Test fun `showing draws media at once and solids at the end of the fade`() {
    f.show(1000)
    assertTrue(f.mediaOn)
    assertFalse(f.solidOn)
    f.tick(1200)
    assertEquals(0.5f, f.alpha, 1e-6f)
    assertFalse(f.solidOn)
    f.tick(1400)
    assertEquals(1f, f.alpha)
    assertTrue(f.solidOn)
  }

  @Test fun `an ordinary hide fades, then turns everything off`() {
    f.show(0)
    f.tick(400)
    f.hide(1000)
    f.tick(1200)
    assertEquals(0.5f, f.alpha, 1e-6f)
    assertTrue(f.mediaOn)
    assertTrue(f.solidOn)
    f.tick(1400)
    assertEquals(0f, f.alpha)
    assertFalse(f.mediaOn)
    assertFalse(f.solidOn)
  }

  @Test fun `hide now turns everything off at once`() {
    f.show(0)
    f.tick(400)
    f.hideNow()
    assertEquals(0f, f.alpha)
    assertFalse(f.mediaOn)
    assertFalse(f.solidOn)
    f.tick(500)
    assertFalse(f.mediaOn)
    assertFalse(f.solidOn)
    // and it can show again
    f.show(600)
    assertTrue(f.mediaOn)
  }

  @Test fun `clear during a fade-out snaps to hidden`() {
    f.show(0)
    f.tick(400)
    f.hide(1000)
    f.tick(1100)
    f.clear()
    assertEquals(0f, f.alpha)
    assertFalse(f.mediaOn)
    assertFalse(f.solidOn)
  }

  @Test fun `hiding before the show has advanced turns media off at once`() {
    f.show(1000)
    f.tick(1000) // alpha still 0
    f.hide(1000)
    assertFalse(f.mediaOn)
    assertFalse(f.solidOn)
  }

  @Test fun `showing again before a hide has advanced keeps solids on`() {
    f.show(0)
    f.tick(400)
    f.hide(1000)
    f.show(1000)
    assertTrue(f.mediaOn)
    assertTrue(f.solidOn)
    assertEquals(1f, f.alpha)
  }
}
