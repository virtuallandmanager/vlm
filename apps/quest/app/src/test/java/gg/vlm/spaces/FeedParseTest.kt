package gg.vlm.spaces

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FeedParseTest {
  @Test
  fun snapshotWithAndWithoutScene() {
    assertEquals("abc", FeedClient.parse("""{"v":1,"version":"abc","scene":{"images":[]}}""")!!.first)
    assertNull(FeedClient.parse("""{"v":1,"version":"abc","scene":null}""")!!.second)
  }

  @Test
  fun rejectsOtherShapes() {
    assertNull(FeedClient.parse("""{"v":2,"version":"abc","scene":null}"""))
    assertNull(FeedClient.parse("""{"v":1,"scene":null}"""))
    assertNull(FeedClient.parse("""{"v":1,"version":"abc"}"""))
    assertNull(FeedClient.parse("not json"))
  }
}
