package io.virvi.ar.builder

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.nayuki.qrcodegen.QrCode

/** The code as shown: `ABC123` becomes `ABC-123`. Anything not six characters is shown as it is. */
fun formatPairingCode(code: String): String {
  val c = code.trim().uppercase().replace("-", "")
  return if (c.length == 6) "${c.substring(0, 3)}-${c.substring(3)}" else code
}

/**
 * The pairing panel: the code in large letters, a QR of the approval page, and Cancel. It is shown while
 * [AuthState.Pairing]; the menu wires it in Task 10.
 */
@Composable
fun PairingPanel(pairing: AuthState.Pairing, onCancel: () -> Unit) {
  val qr = remember(pairing.approveUrl) { QrCode.encodeText(pairing.approveUrl, QrCode.Ecc.MEDIUM) }
  MaterialTheme(colorScheme = darkColorScheme()) {
    Column(
        Modifier.fillMaxSize().background(Color(0xF0101420), RoundedCornerShape(16.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Text(
          formatPairingCode(pairing.code),
          color = Color.White,
          fontSize = 44.sp,
          fontWeight = FontWeight.Bold,
          fontFamily = FontFamily.Monospace,
      )
      QrImage(qr, Modifier.size(180.dp))
      Text("Approve on virvi.io on your phone or computer", color = Color(0xFFE0E0E0), fontSize = 15.sp)
      OutlinedButton(onClick = onCancel) { Text("Cancel") }
    }
  }
}

/** [qr] drawn dark on white with the standard 4-module quiet zone. */
@Composable
private fun QrImage(qr: QrCode, modifier: Modifier) {
  Canvas(modifier) {
    val quiet = 4
    val cells = qr.size + 2 * quiet
    val cell = size.minDimension / cells
    drawRect(Color.White)
    for (y in 0 until qr.size) for (x in 0 until qr.size) {
      if (qr.getModule(x, y)) drawRect(Color.Black, Offset((x + quiet) * cell, (y + quiet) * cell), Size(cell, cell))
    }
  }
}
