package io.virvi.ar.ring

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

/** An 8-bit grey image, row-major. */
class TestsetImage(val gray: ByteArray, val width: Int, val height: Int)

/**
 * Reads an 8-bit grey PNG with javax.imageio.ImageIO. Unit tests compile against android.jar,
 * which lacks javax.imageio and java.awt, so they are reached reflectively (they exist at run
 * time on the JVM).
 */
fun loadTestsetImage(file: File): TestsetImage {
  val image = Class.forName("java.awt.image.BufferedImage")
  val rasterType = Class.forName("java.awt.image.Raster")
  val io = Class.forName("javax.imageio.ImageIO")
  val bi = io.getMethod("read", File::class.java).invoke(null, file)!!
  val width = image.getMethod("getWidth").invoke(bi) as Int
  val height = image.getMethod("getHeight").invoke(bi) as Int
  val raster = image.getMethod("getRaster").invoke(bi)!!
  require(rasterType.getMethod("getNumBands").invoke(raster) == 1) { "$file is not grey" }
  val px =
      rasterType
          .getMethod(
              "getPixels",
              Int::class.java,
              Int::class.java,
              Int::class.java,
              Int::class.java,
              IntArray::class.java,
          )
          .invoke(raster, 0, 0, width, height, null) as IntArray
  return TestsetImage(ByteArray(px.size) { px[it].toByte() }, width, height)
}
