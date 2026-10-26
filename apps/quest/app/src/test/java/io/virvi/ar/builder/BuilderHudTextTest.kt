package io.virvi.ar.builder

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BuilderHudTextTest {
  private val booking = "A booking's layout is live: changes save to that booking only"

  @Test
  fun `booking only gives the booking line`() {
    assertEquals(listOf(booking), hudWarnings(activePresetIsBooking = true, otherPlaces = emptyList()))
  }

  @Test
  fun `two other places are joined with and`() {
    assertEquals(
        listOf("This scene is also shown at Gallery and Shop: changes set to Everywhere move things there too."),
        hudWarnings(false, listOf("Gallery", "Shop")),
    )
  }

  @Test
  fun `three other places read A, B and C`() {
    assertEquals(
        listOf("This scene is also shown at A, B and C: changes set to Everywhere move things there too."),
        hudWarnings(false, listOf("A", "B", "C")),
    )
  }

  @Test
  fun `one other place is named alone`() {
    assertEquals(
        listOf("This scene is also shown at Gallery: changes set to Everywhere move things there too."),
        hudWarnings(false, listOf("Gallery")),
    )
  }

  @Test
  fun `none gives no warnings`() {
    assertTrue(hudWarnings(false, emptyList()).isEmpty())
  }

  @Test
  fun `booking and several places give both lines, booking first`() {
    val w = hudWarnings(true, listOf("Gallery", "Shop"))
    assertEquals(2, w.size)
    assertEquals(booking, w[0])
  }

  @Test
  fun `the banner is word for word`() {
    assertEquals("Builder: visitors don't see your changes until you save", BUILDER_BANNER)
  }

  @Test
  fun `the held message names who is moving the item`() {
    assertEquals("Sam (headset) is moving this", heldMessage("Sam (headset)"))
  }
}
