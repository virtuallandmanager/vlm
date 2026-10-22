package gg.vlm.spaces.quest.ring

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class RingCodecTest {
  private fun bits(s: String): BooleanArray = BooleanArray(s.length) { s[it] == '1' }

  private fun cellsOf(s: String): Array<Boolean?> =
      Array(s.length) { if (s[it] == '?') null else s[it] == '1' }

  @Test
  fun vectorsMatch() {
    val root =
        Json.parseToJsonElement(File("../../ring-marker/vectors/codec.json").readText()).jsonObject
    val encodes = root["encode"]!!.jsonArray
    val decodes = root["decode"]!!.jsonArray
    assertEquals(12, encodes.size)
    assertEquals(13, decodes.size)

    for (v in encodes) {
      val o = v.jsonObject
      val id = o["id"]!!.jsonPrimitive.content.toLong()
      val version = o["version"]!!.jsonPrimitive.content.toInt()
      assertArrayEquals(
          "encode $id v$version",
          bits(o["cells"]!!.jsonPrimitive.content),
          RingCodec.encode(id, version),
      )
    }

    for (v in decodes) {
      val o = v.jsonObject
      val rule = o["rule"]!!.jsonPrimitive.content
      val expect = o["expect"]!!
      val want =
          if (expect is JsonNull) null
          else {
            val e: JsonObject = expect.jsonObject
            RingDecoded(
                e["id"]!!.jsonPrimitive.content.toLong(),
                e["version"]!!.jsonPrimitive.content.toInt(),
                e["corrected"]!!.jsonPrimitive.content.toInt(),
            )
          }
      assertEquals("decode: $rule", want, RingCodec.decode(cellsOf(o["cells"]!!.jsonPrimitive.content)))
    }
  }

  @Test
  fun codeOfIsCrockfordBase32() {
    assertEquals("0000000", RingCodec.codeOf(0))
    assertEquals("3ZZZZZZ", RingCodec.codeOf(0xFFFFFFFFL))
  }

  @Test
  fun testMarkersAreThePythonOnes() {
    assertEquals(0x2E3D4C5BL, RING_TEST_MARKERS.first { it.name == "RING140" }.id)
  }
}
