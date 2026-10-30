package io.virvi.ar.roomscan

import io.virvi.ar.Vec3
import io.virvi.ar.api.BuilderCall
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomScanFlowTest {
  private var ui = RoomScanUi()
  private var rooms = listOf(room("a"))
  private var answer: BuilderCall<RoomScanUpload> = BuilderCall.Ok(RoomScanUpload.Uploaded("scan-1", "My room"))
  private val uploads = ArrayList<Triple<String, String, JsonObject>>()
  private var setUps = 0

  private fun room(id: String) =
      ScanRoom(id, null, ScanPose(Vec3(0.0, 0.0, 0.0), 0.0), listOf(0f to 0f, 1f to 0f, 1f to 1f), 0f, 2.5f, emptyList(), emptyList(), emptyList())

  private val flow =
      RoomScanFlow(
          CoroutineScope(Dispatchers.Unconfined),
          read = { RoomScanInput(rooms) },
          upload = { spaceId, name, layout ->
            uploads += Triple(spaceId, name, layout)
            answer
          },
          spaceId = { "sp1" },
          setUpSpace = { done ->
            setUps++
            done()
          },
          show = { ui = it },
      )

  @Test
  fun `opening reads the rooms, outlines them and names one room My room`() {
    flow.open()
    assertTrue(ui.open)
    assertEquals("My room", ui.name)
    assertEquals(listOf(listOf(0f to 0f, 1f to 0f, 1f to 1f)), ui.outlines)
    assertTrue(ui.canUpload)
  }

  @Test
  fun `several rooms are My home`() {
    rooms = listOf(room("a"), room("b"))
    flow.open()
    assertEquals("My home", ui.name)
  }

  @Test
  fun `upload sends the mapped layout for the space with the name, then says it's done`() {
    flow.open()
    flow.setName("  Studio  ")
    flow.upload()
    val (spaceId, name, layout) = uploads.single()
    assertEquals("sp1", spaceId)
    assertEquals("Studio", name)
    assertEquals(1, layout["version"]!!.jsonPrimitive.int)
    assertEquals(RoomScanCopy.uploaded("My room"), ui.status)
    assertFalse(ui.canUpload)
  }

  @Test
  fun `a refusal shows the server's line`() {
    answer = BuilderCall.Ok(RoomScanUpload.Refused(RoomScanCopy.SHARED_DEVICE))
    flow.open()
    flow.upload()
    assertEquals(RoomScanCopy.SHARED_DEVICE, ui.status)
    assertTrue(ui.canUpload) // it can be tried again
  }

  @Test
  fun `offline says so`() {
    answer = BuilderCall.Offline
    flow.open()
    flow.upload()
    assertEquals(RoomScanCopy.OFFLINE, ui.status)
  }

  @Test
  fun `a blank name can't be uploaded and names are kept to 120 characters`() {
    flow.open()
    flow.setName("   ")
    assertFalse(ui.canUpload)
    flow.setName("x".repeat(200))
    assertEquals(120, ui.name.length)
  }

  @Test
  fun `no rooms offers Space Setup, and opens again once it's done`() {
    rooms = emptyList()
    flow.open()
    assertTrue(ui.noRooms)
    assertEquals(RoomScanCopy.NO_ROOMS, ui.status)
    assertFalse(ui.canUpload)
    rooms = listOf(room("a"))
    flow.setUpSpace()
    assertEquals(1, setUps)
    assertFalse(ui.noRooms)
    assertTrue(ui.canUpload)
  }

  @Test
  fun `closing hides the panel and drops a late answer`() {
    flow.open()
    flow.close()
    assertFalse(ui.open)
    assertNull(ui.status)
  }
}
