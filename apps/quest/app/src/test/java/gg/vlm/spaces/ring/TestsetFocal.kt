package gg.vlm.spaces.ring

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** The focal length (px) the ring-marker synthetic test set was rendered at, read from its manifest. */
val testsetFocalPx: Double by lazy {
  val entries = Json.parseToJsonElement(File("../../ring-marker/testset/manifest.json").readText()).jsonArray
  val focals = entries.map { it.jsonObject["focal_px"]!!.jsonPrimitive.double }.distinct()
  check(focals.size == 1) { "test set mixes focal lengths: $focals" }
  focals.single()
}
