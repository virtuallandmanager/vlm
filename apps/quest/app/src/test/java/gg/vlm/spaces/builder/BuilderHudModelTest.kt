package gg.vlm.spaces.builder

import gg.vlm.spaces.Vec3
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BuilderHudModelTest {
  private fun scene(s: String) = Json.parseToJsonElement(s).jsonObject

  @Test
  fun `builderItems reads instances with their kind, name and render key`() {
    val items =
        builderItems(
            scene(
                """{"videos":[],"images":[{"sk":"el1","name":"Poster","textureSrc":"https://x/p.png","instances":[
                  {"sk":"in1","position":{"x":1,"y":2,"z":3},"rotation":{"x":0,"y":90,"z":0},"scale":{"x":2,"y":1,"z":1}}]}],
                  "models":[{"sk":"el2","modelSrc":"https://x/chair.glb?v=2","instances":[{"sk":"in2"}]}],"sounds":[]}"""
            )
        )
    assertEquals(listOf("in1", "in2"), items.map { it.sk })
    val poster = items[0]
    assertEquals("el1:in1", poster.renderKey)
    assertEquals("image", poster.element)
    assertEquals("Poster", poster.name)
    assertEquals(ItemTransform(Vec3(1.0, 2.0, 3.0), Vec3(0.0, 90.0, 0.0), Vec3(2.0, 1.0, 1.0)), poster.now)
    assertEquals(poster.now, poster.shared)
    assertNull(poster.adjustment)
    assertEquals("chair.glb", items[1].name)
    assertEquals(Vec3(1.0, 1.0, 1.0), items[1].now.scale)
  }

  @Test
  fun `an adjusted instance carries its shared transform and adjustment`() {
    val item =
        builderItems(
                scene(
                    """{"models":[{"sk":"el2","name":"Chair","instances":[{"sk":"in2","position":{"x":2.5,"y":0,"z":0},
                      "arAdjusted":true,"arShared":{"position":{"x":2,"y":0,"z":0},"rotation":{"x":0,"y":0,"z":0},"scale":{"x":1,"y":1,"z":1}},
                      "arAdjustment":{"dPosition":{"x":0.5,"y":0,"z":0},"dRotation":{"x":0,"y":0,"z":0},"scaleFactor":{"x":1,"y":1,"z":1}}}]}]}"""
                )
            )
            .single()
    assertTrue(item.adjusted)
    assertEquals(2.0, item.shared.position.x, 0.0)
    assertEquals(2.5, item.now.position.x, 0.0)
    assertEquals(0.5, item.adjustment!!.dPosition.x, 0.0)
  }

  @Test
  fun `disabled elements and instances, and instances without an sk, are left out`() {
    val items =
        builderItems(
            scene(
                """{"images":[{"sk":"a","enabled":false,"instances":[{"sk":"1"}]},
                  {"sk":"b","instances":[{"sk":"2","enabled":false},{"sk":"3"},{}]}]}"""
            )
        )
    assertEquals(listOf("3"), items.map { it.sk })
    assertTrue(builderItems(null).isEmpty())
  }

  @Test
  fun `exact values format to centimetres and tenths of a degree, and parse back`() {
    assertEquals("1.25", formatExact(TransformMode.MOVE, 1.2549))
    assertEquals("0.00", formatExact(TransformMode.MOVE, -0.0))
    assertEquals("-12.5", formatExact(TransformMode.ROTATE, -12.46))
    assertEquals(-1.5, parseExact(" -1,5 ")!!, 0.0)
    assertNull(parseExact("abc"))
    assertNull(parseExact("NaN"))
    assertNull(parseExact("Infinity"))
  }

  @Test
  fun `the hud floats 0_6 m to the builder's left, facing them`() {
    val (p, yaw) = builderHudPlacement(Vec3(0.0, 1.6, 0.0), 0.0)
    assertEquals(-0.6, p.x, 1e-9)
    assertEquals(1.45, p.y, 1e-9)
    assertEquals(0.3, p.z, 1e-9)
    assertEquals(Math.toDegrees(Math.atan2(-0.6, 0.3)), yaw, 1e-9)
    // Facing +X, the left is +Z.
    val (q, _) = builderHudPlacement(Vec3(0.0, 1.6, 0.0), 90.0)
    assertEquals(0.6, q.z, 1e-9)
    assertEquals(0.3, q.x, 1e-9)
  }

  @Test
  fun `kind labels`() {
    assertEquals(listOf("Image", "Video", "Model", "Sound", "Ad space"), listOf("image", "video", "model", "sound", "ad_space").map(::kindLabel))
  }

  @Test
  fun `save failures are counted`() {
    assertEquals("Couldn't save 2 changes: try again", saveFailedMessage(2))
  }
}
