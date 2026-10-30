package io.virvi.ar.roomscan

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val TEXT = Color.White
private val SUBTLE = Color(0xFFB0B8C8)
private val OUTLINE = Color(0xFF4FC3F7)

/**
 * The Layout tab's **Scan this room**: a button, or once opened, the rooms' outline seen from above, the scan's name
 * and **Upload** (or **Set up my space** when the headset has no rooms). Leaving the tab or the HUD closes it.
 */
@Composable
fun RoomScanSection(ui: RoomScanUi, flow: RoomScanFlow) {
  DisposableEffect(Unit) { onDispose { flow.close() } }
  if (!ui.open) {
    OutlinedButton(onClick = flow::open, modifier = Modifier.fillMaxWidth()) { Text(RoomScanCopy.SCAN_THIS_ROOM) }
    return
  }
  Column(
      Modifier.fillMaxWidth().background(Color(0x22FFFFFF), RoundedCornerShape(10.dp)).padding(8.dp),
      verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Text(RoomScanCopy.SCAN_THIS_ROOM, color = TEXT, fontSize = 15.sp)
    if (ui.outlines.isNotEmpty()) RoomOutline(ui.outlines, Modifier.fillMaxWidth().height(140.dp))
    if (!ui.noRooms) {
      OutlinedTextField(
          value = ui.name,
          onValueChange = flow::setName,
          singleLine = true,
          enabled = !ui.uploading && !ui.uploaded,
          label = { Text("Name") },
          textStyle = MaterialTheme.typography.bodyMedium,
          modifier = Modifier.fillMaxWidth(),
      )
    }
    ui.status?.let { Text(it, color = SUBTLE, fontSize = 13.sp) }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      if (ui.noRooms) Button(onClick = flow::setUpSpace) { Text(RoomScanCopy.SET_UP_SPACE) }
      else Button(onClick = flow::upload, enabled = ui.canUpload) { Text(RoomScanCopy.UPLOAD) }
      TextButton(onClick = flow::close) { Text("Close") }
    }
  }
}

/** Every room's floor outline, fitted into the box, seen from above: +x to the right, +z (forward) up. */
@Composable
private fun RoomOutline(outlines: List<List<Pair<Float, Float>>>, modifier: Modifier) {
  Canvas(modifier) {
    val points = outlines.flatten()
    if (points.isEmpty()) return@Canvas
    val minX = points.minOf { it.first }
    val maxX = points.maxOf { it.first }
    val minZ = points.minOf { it.second }
    val maxZ = points.maxOf { it.second }
    val pad = 8f
    val scale = minOf((size.width - 2 * pad) / (maxX - minX).coerceAtLeast(0.1f), (size.height - 2 * pad) / (maxZ - minZ).coerceAtLeast(0.1f))
    val left = (size.width - (maxX - minX) * scale) / 2
    val top = (size.height - (maxZ - minZ) * scale) / 2
    fun at(p: Pair<Float, Float>) = Offset(left + (p.first - minX) * scale, top + (maxZ - p.second) * scale)
    for (outline in outlines) {
      if (outline.size < 2) continue
      val path = Path().apply {
        moveTo(at(outline[0]).x, at(outline[0]).y)
        outline.drop(1).forEach { val o = at(it); lineTo(o.x, o.y) }
        close()
      }
      drawPath(path, OUTLINE, style = Stroke(width = 3f))
    }
  }
}
