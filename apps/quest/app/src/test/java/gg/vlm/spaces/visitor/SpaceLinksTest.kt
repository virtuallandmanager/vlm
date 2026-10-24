package gg.vlm.spaces.visitor

import gg.vlm.spaces.ring.RingCodec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class SpaceLinksTest {
  @Test fun `a link with a trailing slash, query and hyphens gives the normalised code`() {
    assertEquals("2E3D4C5", spaceCodeFromUri("https://vlm.gg/s/2e3d-4c5/?ref=x"))
  }

  @Test fun `I and L read as 1, O as 0`() {
    assertEquals("1100000", spaceCodeFromUri("https://vlm.gg/s/IlOo000"))
  }

  @Test fun `plain and fragment links work`() {
    assertEquals("2E3D4C5", spaceCodeFromUri("https://vlm.gg/s/2E3D4C5"))
    assertEquals("2E3D4C5", spaceCodeFromUri("https://vlm.gg/s/2E3D4C5#top"))
  }

  @Test fun `other hosts, paths, schemes and short or invalid codes give null`() {
    assertNull(spaceCodeFromUri("https://example.com/s/ABCDEFG"))
    assertNull(spaceCodeFromUri("https://vlm.gg/s/ABC"))
    assertNull(spaceCodeFromUri("https://vlm.gg/s/ABCDEFG")) // value is 2^32 or more
    assertNull(spaceCodeFromUri("https://vlm.gg/s/2E3D4CU")) // U is not in the alphabet
    assertNull(spaceCodeFromUri("https://vlm.gg/x/2E3D4C5"))
    assertNull(spaceCodeFromUri("https://vlm.gg/s/2E3D4C5/more"))
    assertNull(spaceCodeFromUri("http://vlm.gg/s/2E3D4C5"))
    assertNull(spaceCodeFromUri("https://vlm.gg.evil.com/s/2E3D4C5"))
    assertNull(spaceCodeFromUri(""))
  }

  @Test fun `parseCode mirrors the server`() {
    assertEquals(RingCodec.parseCode("2E3D4C5"), RingCodec.parseCode("2e3d-4c5"))
    assertNotNull(RingCodec.parseCode("2E3D4C5"))
    assertEquals(RingCodec.parseCode("1100000"), RingCodec.parseCode("  il-oo 000 "))
    assertNull(RingCodec.parseCode("2E3D4C"))
    assertNull(RingCodec.parseCode("2E3D4C55"))
    assertNull(RingCodec.parseCode("4000000")) // 4 << 30 = 2^32
    assertEquals(0xFFFFFFFFL, RingCodec.parseCode("3ZZZZZZ"))
    val id = 0x1C2B3A4AL
    assertEquals(id, RingCodec.parseCode(RingCodec.codeOf(id)))
  }

  private fun r(code: String, at: Long) = RecentSpace(code, "Space $code", at)

  @Test fun `remember keeps newest first and drops the older duplicate`() {
    val list = remember(remember(remember(emptyList(), r("A", 1)), r("B", 2)), r("A", 3))
    assertEquals(listOf(r("A", 3), r("B", 2)), list)
  }

  @Test fun `remember caps the list`() {
    var list = emptyList<RecentSpace>()
    for (i in 1..25) list = remember(list, r("C$i", i.toLong()))
    assertEquals(20, list.size)
    assertEquals("C25", list.first().code)
    assertEquals("C6", list.last().code)
    assertEquals(3, remember(listOf(r("A", 1), r("B", 2), r("C", 3)), r("D", 4), max = 3).size)
  }

  @Test fun `recent spaces survive being saved and read back, and bad data reads as empty`() {
    val list = listOf(r("A", 3), RecentSpace("B", "Cafe \"B\"", 2))
    assertEquals(list, decodeRecents(encodeRecents(list)))
    assertEquals(emptyList<RecentSpace>(), decodeRecents(null))
    assertEquals(emptyList<RecentSpace>(), decodeRecents("not json"))
    assertEquals(listOf(r("A", 3)), decodeRecents("""[{"code":"A","spaceName":"Space A","openedAtMs":3},{"code":1}]"""))
  }
}
