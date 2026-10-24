package gg.vlm.spaces.builder

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

const val ASSETS_EMPTY = "Nothing in this scene's library yet"
const val ASSETS_LOADING = "Loading the library…"
const val ASSETS_FAILED = "Couldn't load the library"
const val NOT_SHOWN_ON_HEADSET = "Not shown on the headset"
private const val THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024
const val PLACE_FAILED = "Couldn't place that: try again"

/** The Assets tab's state: [entries] is null while the library loads or if it didn't ([failed]). */
data class AssetsState(val entries: List<LibraryEntry>?, val failed: Boolean = false)

/** The Assets tab: the scene's library, each with a **Place** button ([onPlace]; the item lands 1 m ahead and is picked). */
@Composable
fun AssetsTab(state: AssetsState, onPlace: (LibraryEntry) -> Unit) {
  val entries = state.entries
  when {
    entries == null -> Text(if (state.failed) ASSETS_FAILED else ASSETS_LOADING, color = Color(0xFFB0B8C8), fontSize = 14.sp)
    entries.isEmpty() -> Text(ASSETS_EMPTY, color = Color(0xFFB0B8C8), fontSize = 14.sp)
    else ->
        LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
          items(entries, key = { it.id }) { e ->
            Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
              Thumbnail(e.thumbnailUrl)
              Column(Modifier.weight(1f).padding(horizontal = 8.dp)) {
                Text(e.name, color = Color.White, fontSize = 14.sp, maxLines = 1)
                Text(
                    kindLabel(e.kind.name.lowercase()) + if (e.drawable) "" else ": $NOT_SHOWN_ON_HEADSET",
                    color = Color(0xFFB0B8C8),
                    fontSize = 12.sp,
                )
              }
              Button(onClick = { onPlace(e) }, enabled = e.drawable) { Text("Place") }
            }
          }
        }
  }
}

/** A small preview where the library gives a URL (decoded once, off the main thread); an empty square otherwise. */
@Composable
private fun Thumbnail(url: String?) {
  var bitmap by remember(url) { mutableStateOf<ImageBitmap?>(null) }
  LaunchedEffect(url) {
    if (url == null) return@LaunchedEffect
    bitmap =
        withContext(Dispatchers.IO) {
          runCatching {
                URL(url).openStream().use { s ->
                  // At most 2 MB: a bigger file is no thumbnail (and no memory spike).
                  val bytes = s.readNBytes(THUMBNAIL_MAX_BYTES + 1)
                  if (bytes.size > THUMBNAIL_MAX_BYTES) return@use null
                  val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                  BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                  val sample = Integer.highestOneBit((maxOf(bounds.outWidth, bounds.outHeight) / 96).coerceAtLeast(1))
                  BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
                      ?.asImageBitmap()
                }
              }
              .getOrNull()
        }
  }
  Box(Modifier.size(40.dp)) {
    bitmap?.let { Image(it, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(40.dp)) }
  }
}
