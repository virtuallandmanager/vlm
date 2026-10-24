package gg.vlm.spaces.builder

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** The lines the panel shows for [state], top to bottom: the instruction, then [extra] notes (size and floor warnings). */
fun alignLines(state: AlignState, extra: List<String>): List<String> =
    when (state) {
      AlignState.LookAtRing -> listOf("Look at the ring")
      is AlignState.Placed -> listOf("Left stick moves the scene, right stick turns it. Hold the grip for fine steps.") + extra
      AlignState.Saving -> listOf("Saving…")
      is AlignState.Saved -> listOf("Alignment saved") + extra
      is AlignState.Refused -> listOf(state.reason) + extra
    }

/**
 * The align panel: a view of [AlignFlow]'s [state]. [notes] are the printed-size message and, once saved, the floor
 * warnings. **Save alignment** shows once the scene is placed. Not wired into the menu yet (Task 10).
 */
@Composable
fun AlignPanel(state: AlignState, notes: List<String>, onSave: () -> Unit, onClose: () -> Unit) {
  val lines = alignLines(state, notes)
  MaterialTheme(colorScheme = darkColorScheme()) {
    Column(
        Modifier.fillMaxSize().background(Color(0xF0101420), RoundedCornerShape(16.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Text(lines.first(), color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
      lines.drop(1).forEach { Text(it, color = Color(0xFFE0E0E0), fontSize = 15.sp) }
      if (state is AlignState.Placed || state is AlignState.Refused) Button(onClick = onSave) { Text("Save alignment") }
      OutlinedButton(onClick = onClose) { Text(if (state is AlignState.Saved) "Done" else "Cancel") }
    }
  }
}
