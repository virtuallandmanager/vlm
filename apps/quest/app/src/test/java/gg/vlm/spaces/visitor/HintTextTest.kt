package gg.vlm.spaces.visitor

import gg.vlm.spaces.Vec3
import gg.vlm.spaces.api.ArSpace
import gg.vlm.spaces.space.RootPose
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HintTextTest {
  private val space = ArSpace("sp", "Cafe", null, true, emptyList())

  @Test fun `the visitor copy word for word`() {
    assertEquals("Look for a ring like this, at eye level near the entrance.", hintText(VisitorState.Hint, false))
    assertEquals("Step closer to the ring", hintText(VisitorState.StepCloser, false))
    assertEquals("Opening Cafe…", hintText(VisitorState.Loading("ABC", "Cafe"), false))
    assertEquals("Opening…", hintText(VisitorState.Loading("ABC", null), false))
    assertEquals("Hold still…", hintText(VisitorState.Locking(space), false))
    assertEquals("This space isn't set up yet", hintText(VisitorState.NotSetUp("Cafe"), false))
    assertEquals(VisitorCopy.OFFLINE, hintText(VisitorState.Failed(VisitorCopy.OFFLINE), false))
  }

  @Test fun `locking with the ring too far says step closer`() {
    assertEquals("Step closer to the ring", hintText(VisitorState.Locking(space), true))
  }

  @Test fun `too far only matters while locking`() {
    assertEquals(VisitorCopy.HINT, hintText(VisitorState.Hint, true))
  }

  @Test fun `no card while the scene is shown`() {
    assertNull(hintText(VisitorState.Shown(space, RootPose(Vec3(0.0, 0.0, 0.0), 0.0)), false))
  }
}
