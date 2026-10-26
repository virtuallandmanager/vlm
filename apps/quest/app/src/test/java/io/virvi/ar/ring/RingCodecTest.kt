package io.virvi.ar.ring

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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
    assertEquals(15, decodes.size)

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

  /** Each test marker's id and diameter match the Python test set's range images and the encode vectors. */
  @Test
  fun testMarkersAreThePythonOnes() {
    assertEquals(listOf("RING120", "RING140", "RING170"), RING_TEST_MARKERS.map { it.name })
    val manifest =
        Json.parseToJsonElement(File("../../ring-marker/testset/manifest.json").readText()).jsonArray
    val encodedIds =
        Json.parseToJsonElement(File("../../ring-marker/vectors/codec.json").readText())
            .jsonObject["encode"]!!
            .jsonArray
            .map { it.jsonObject }
            .filter { it["version"]!!.jsonPrimitive.content == "0" }
            .map { it["id"]!!.jsonPrimitive.content.toLong() }
    for (m in RING_TEST_MARKERS) {
      val drawn =
          manifest
              .map { it.jsonObject }
              .filter { it["name"]!!.jsonPrimitive.content.startsWith("range-${m.name}-") }
              .flatMap { it["markers"]!!.jsonArray }
              .map { it.jsonObject }
      assertTrue("${m.name} has range images", drawn.isNotEmpty())
      for (d in drawn) {
        assertEquals(m.name, m.id, d["id"]!!.jsonPrimitive.content.toLong())
        assertEquals(m.name, m.diameter * 1000, d["diameter_mm"]!!.jsonPrimitive.content.toDouble(), 1e-9)
      }
      assertTrue("${m.name} in the encode vectors", m.id in encodedIds)
    }
  }
}
