package gg.vlm.spaces.visitor

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import gg.vlm.spaces.ring.RingCodec

/** What the hint card says in [state], or null when it is hidden (the scene is shown). */
fun hintText(state: VisitorState, tooFar: Boolean): String? =
    when (state) {
      VisitorState.Hint -> VisitorCopy.HINT
      VisitorState.StepCloser -> VisitorCopy.TOO_FAR
      is VisitorState.Loading -> VisitorCopy.opening(state.spaceName)
      is VisitorState.Locking -> if (tooFar) VisitorCopy.TOO_FAR else VisitorCopy.HOLD_STILL
      is VisitorState.NotSetUp -> VisitorCopy.NOT_SET_UP
      is VisitorState.Failed -> state.message
      is VisitorState.Shown -> null
    }

/** The hint card (0.5 × 0.3 m, 250 × 150 dp): a drawing of a ring marker and the line [text]. */
@Composable
fun HintCard(text: String) {
  Row(
      Modifier.fillMaxSize().background(Color(0xF0101420), RoundedCornerShape(16.dp)).padding(14.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    RingDrawing(Modifier.fillMaxHeight().aspectRatio(1f))
    Text(text, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Medium, lineHeight = 21.sp)
  }
}

/**
 * A ring marker as printed (apps/ring-marker/ringmarker/layout.py): the finder ring with its gap at the top, three
 * rings of 24 cells, and the centre dot, on a light plaque. It draws a fixed demo id, never a real space's ring.
 */
@Composable
private fun RingDrawing(modifier: Modifier) {
  Canvas(modifier.background(Color(0xFFF2F2F2), RoundedCornerShape(8.dp))) {
    val unit = size.minDimension / 150f // the plaque is 150 at the 140 reference diameter
    val ink = Color(0xFF111111)
    arc(ink, (FINDER.first + FINDER.second) / 2 * unit, (FINDER.second - FINDER.first) * unit, 8f, 344f)
    CODE_RINGS.forEachIndexed { ring, (r0, r1) ->
      val mid = (r0 + r1) / 2 * unit
      val width = (r1 - r0) * unit
      for (cell in 0 until 24) {
        if (!DEMO_CELLS[ring * 24 + cell]) continue
        arc(ink, mid, width, cell * 15f + INSET, 15f - 2 * INSET)
      }
    }
    drawCircle(ink, DOT * unit, center)
  }
}

/** An arc of the ring at [radius] (stroke [width]), from [fromTopDeg] clockwise from the top, [sweepDeg] long. */
private fun DrawScope.arc(color: Color, radius: Float, width: Float, fromTopDeg: Float, sweepDeg: Float) {
  drawArc(
      color,
      startAngle = fromTopDeg - 90f, // Compose measures clockwise from 3 o'clock
      sweepAngle = sweepDeg,
      useCenter = false,
      topLeft = Offset(center.x - radius, center.y - radius),
      size = Size(radius * 2, radius * 2),
      style = Stroke(width),
  )
}

/** A made-up id for the drawing only. */
private const val DEMO_RING_ID = 0x5EED5EEDL
private val DEMO_CELLS = RingCodec.encode(DEMO_RING_ID)
private val FINDER = 62f to 70f
private val CODE_RINGS = listOf(51f to 59f, 40f to 48f, 29f to 37f) // ring 0 outermost
private const val DOT = 12f
private const val INSET = 1.2f
