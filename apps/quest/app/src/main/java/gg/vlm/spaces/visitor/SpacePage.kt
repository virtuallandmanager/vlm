package gg.vlm.spaces.visitor

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import gg.vlm.spaces.AppState

/** What the space page says, top to bottom. [hint] is the live line (step closer, hold still, a failure), or null. */
data class SpacePageLines(val title: String, val where: String?, val instruction: String, val hint: String?)

/**
 * What [page] shows: its name (else [problem], else "Opening…"), where to find it, the instruction, and the live [hint]
 * unless it only repeats the title.
 */
fun spacePageLines(page: SpacePageInfo, hint: String?, problem: String?): SpacePageLines {
  val title = page.spaceName ?: problem ?: VisitorCopy.opening(null)
  return SpacePageLines(title, page.whereText, VisitorCopy.LOOK_AT_RING, hint?.takeIf { it != title })
}

/** The page once the flow is at [state]: it closes by itself when the scene is shown. */
fun spacePageFor(page: SpacePageInfo?, state: VisitorState): SpacePageInfo? =
    if (state is VisitorState.Shown) null else page

/**
 * The space page (0.5 × 0.4 m): shown when a link or a Spaces pick opens a space. "Opening…" until the lookup answers
 * (or its [AppState.spaceProblem]), then the space's name and where to find its ring.
 */
@Composable
fun SpacePage(s: AppState, onClose: () -> Unit) {
  val page = s.spacePage ?: return
  MaterialTheme(colorScheme = darkColorScheme()) {
    Column(
        Modifier.fillMaxSize().background(Color(0xF0101420), RoundedCornerShape(16.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      val lines = spacePageLines(page, s.hint, s.spaceProblem)
      Text(
          lines.title,
          color = Color.White,
          fontSize = 20.sp,
          fontWeight = FontWeight.Medium,
      )
      lines.where?.let { Text(it, color = Color(0xFFE0E0E0), fontSize = 15.sp) }
      Text(lines.instruction, color = Color(0xFFE0E0E0), fontSize = 15.sp)
      lines.hint?.let { Text(it, color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Medium) }
      Spacer(Modifier.weight(1f))
      Button(onClose, Modifier.fillMaxWidth()) { Text(VisitorCopy.CLOSE, fontSize = 14.sp) }
    }
  }
}
