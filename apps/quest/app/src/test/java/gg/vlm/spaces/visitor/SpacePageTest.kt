package gg.vlm.spaces.visitor

import gg.vlm.spaces.api.ArSpace
import gg.vlm.spaces.space.RootPose
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SpacePageTest {
  private val opening = SpacePageInfo("2E3D4C5", null, null)
  private val named = SpacePageInfo("2E3D4C5", "Cafe", "By the stairs")

  @Test fun `before the lookup answers it says Opening and repeats nothing`() {
    val l = spacePageLines(opening, VisitorCopy.opening(null), null)
    assertEquals(VisitorCopy.opening(null), l.title)
    assertNull(l.hint)
    assertEquals(VisitorCopy.LOOK_AT_RING, l.instruction)
  }

  @Test fun `a named page shows where, the instruction and the live hint`() {
    val l = spacePageLines(named, VisitorCopy.HOLD_STILL, null)
    assertEquals(SpacePageLines("Cafe", "By the stairs", VisitorCopy.LOOK_AT_RING, VisitorCopy.HOLD_STILL), l)
    assertEquals(VisitorCopy.TOO_FAR, spacePageLines(named, VisitorCopy.TOO_FAR, null).hint)
  }

  @Test fun `a failed lookup shows the failure once`() {
    val l = spacePageLines(opening, VisitorCopy.NOT_OPEN, VisitorCopy.NOT_OPEN)
    assertEquals(VisitorCopy.NOT_OPEN, l.title)
    assertNull(l.hint)
  }

  @Test fun `the page closes by itself when the scene is shown, and not before`() {
    val space = ArSpace("s", "Cafe", null, true, emptyList())
    assertNull(spacePageFor(named, VisitorState.Shown(space, RootPose(0.0, 0.0, 0.0, 0.0))))
    assertEquals(named, spacePageFor(named, VisitorState.Locking(space)))
    assertEquals(named, spacePageFor(named, VisitorState.Loading("2E3D4C5", "Cafe")))
    assertNull(spacePageFor(null, VisitorState.Hint))
  }
}
