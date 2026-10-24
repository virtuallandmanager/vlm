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
      Text(
          page.spaceName ?: s.spaceProblem ?: "Opening…",
          color = Color.White,
          fontSize = 20.sp,
          fontWeight = FontWeight.Medium,
      )
      page.whereText?.let { Text(it, color = Color(0xFFE0E0E0), fontSize = 15.sp) }
      Text(VisitorCopy.LOOK_AT_RING, color = Color(0xFFE0E0E0), fontSize = 15.sp)
      Spacer(Modifier.weight(1f))
      Button(onClose, Modifier.fillMaxWidth()) { Text(VisitorCopy.CLOSE, fontSize = 14.sp) }
    }
  }
}
