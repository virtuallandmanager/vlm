package gg.vlm.spaces

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class ScenePlanTest {
  @Test
  fun imagesVideosModelsAndSkips() {
    val scene =
        Json.parseToJsonElement(
                """
        {"images":[{"sk":"img","textureSrc":"https://x/a.PNG?x=1","instances":[
            {"sk":"i1","position":{"x":1,"y":2,"z":3},"scale":{"x":4,"y":2,"z":1}},
            {"sk":"i2","enabled":false}]},
          {"sk":"gif","textureSrc":"https://x/a.gif","instances":[{"sk":"g"}]}],
         "videos":[{"sk":"vid","offType":1,"offImageSrc":"https://x/off.jpg","instances":[{"sk":"v1"}]},
                   {"sk":"pl","offType":2,"playlist":["https://x/p.mp4"],"volume":0.5,"instances":[{"sk":"p1"}]}],
         "models":[{"sk":"m","modelSrc":"https://x/m.glb","enabled":true,"instances":[{"sk":7}]},
                   {"sk":"off","modelSrc":"https://x/o.glb","enabled":false,"instances":[{"sk":"o1"}]}],
         "sounds":[]}
        """
            )
            .jsonObject
    val items = planScene(scene)
    assertEquals(listOf("vid:v1", "pl:p1", "img:i1", "m:7"), items.map { it.key })
    assertEquals(RenderItem.Kind.IMAGE, items[0].kind)
    assertEquals(0.0, items[0].volume, 0.0)
    assertEquals(RenderItem.Kind.VIDEO, items[1].kind)
    assertEquals(0.5, items[1].volume, 0.0)
    assertEquals(4.0, items[2].width, 0.0)
    assertEquals(2.0, items[2].height, 0.0)
    assertEquals(Vec3(1.0, 2.0, 3.0), items[2].transform.position)
    assertEquals("m.glb", items[3].name)
  }

  @Test
  fun diff() {
    fun plan(json: String) = planScene(Json.parseToJsonElement(json).jsonObject)
    val a = plan("""{"images":[{"sk":"e","textureSrc":"https://x/a.png","instances":[{"sk":"1"},{"sk":"2"}]}]}""")
    val b =
        plan(
            """{"images":[{"sk":"e","textureSrc":"https://x/a.png","instances":[{"sk":"2","scale":{"x":2}},{"sk":"3"}]}]}"""
        )
    val d = diffPlans(a, b)
    assertEquals(listOf("e:1"), d.remove)
    assertEquals(listOf("e:2"), d.update.map { it.key })
    assertEquals(listOf("e:3"), d.add.map { it.key })
  }
}
