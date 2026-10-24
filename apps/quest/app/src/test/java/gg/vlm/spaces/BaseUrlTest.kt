package gg.vlm.spaces

import org.junit.Assert.assertEquals
import org.junit.Test

class BaseUrlTest {
  @Test fun `release always uses vlm gg`() {
    assertEquals("https://vlm.gg", resolveBaseUrl(debug = false, extra = "http://10.0.0.2:3000", saved = "http://x"))
  }

  @Test fun `debug takes the extra, then the saved one, then vlm gg`() {
    assertEquals("http://10.0.0.2:3000", resolveBaseUrl(true, "http://10.0.0.2:3000", "http://x"))
    assertEquals("http://x", resolveBaseUrl(true, null, "http://x"))
    assertEquals("https://vlm.gg", resolveBaseUrl(true, null, null))
  }

  @Test fun `debug ignores anything that isn't an http url`() {
    assertEquals("http://x", resolveBaseUrl(true, "vlm.gg", "http://x"))
    assertEquals("https://vlm.gg", resolveBaseUrl(true, "  ", "ftp://x"))
  }
}
