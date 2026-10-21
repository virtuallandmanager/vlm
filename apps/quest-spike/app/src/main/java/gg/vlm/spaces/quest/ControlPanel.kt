package gg.vlm.spaces.quest

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** The one panel: connection, scene placement and the marker detection-range test. */
@Composable
fun ControlPanel(s: AppState, act: PanelActions) {
  MaterialTheme(colorScheme = darkColorScheme()) {
    Column(
        Modifier.fillMaxSize()
            .background(Color(0xF0101420), RoundedCornerShape(24.dp))
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Text("VLM Spaces", color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold)

      Section("Scene")
      OutlinedTextField(
          s.feedUrl,
          { s.feedUrl = it },
          label = { Text("Feed URL") },
          singleLine = true,
          keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
          modifier = Modifier.fillMaxWidth(),
      )
      OutlinedTextField(
          s.worldKey,
          { s.worldKey = it },
          label = { Text("World key (vlmw_…)") },
          singleLine = true,
          visualTransformation = PasswordVisualTransformation(),
          modifier = Modifier.fillMaxWidth(),
      )
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Button(onClick = act::connect) { Text("Connect") }
        Column {
          val v = s.feed.version?.let { " · version $it" } ?: ""
          Line("${s.feed.state}$v · ${s.itemCount} items")
          s.feed.lastError?.let { Line(it, Color(0xFFFF8A80)) }
        }
      }

      Section("Placement")
      Line(s.placement)
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = act::placeAhead) { Text("Place 2 m ahead") }
        OutlinedButton(onClick = { act.turn(15.0) }) { Text("Turn ↻ 15°") }
        OutlinedButton(onClick = { act.turn(-15.0) }) { Text("Turn ↺ 15°") }
      }
      Button(onClick = act::alignToMarker) { Text("Align to the marker") }
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Switch(s.modelTurn, act::setModelTurn)
        Line("Turn models half a turn (check against Decentraland)")
      }

      Section("Marker test")
      Line(s.markerStatus)
      s.markerLines.forEach { Line(it, mono = true) }
      Line(s.lastQr, mono = true)
      OutlinedButton(onClick = act::resetReadings) { Text("Reset readings") }
    }
  }
}

@Composable
private fun Section(text: String) {
  Text(text, color = Color(0xFFB4A8FF), fontSize = 18.sp, fontWeight = FontWeight.SemiBold,
      modifier = Modifier.padding(top = 8.dp))
}

@Composable
private fun Line(text: String, color: Color = Color(0xFFE0E0E0), mono: Boolean = false) {
  Text(text, color = color, fontSize = 15.sp, fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default)
}
