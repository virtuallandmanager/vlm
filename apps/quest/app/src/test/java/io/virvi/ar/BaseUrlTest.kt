package io.virvi.ar

import org.junit.Assert.assertEquals
import org.junit.Test

class BaseUrlTest {
  @Test fun `release always uses virvi gg`() {
    assertEquals("https://virvi.io", resolveBaseUrl(debug = false, extra = "http://10.0.0.2:3000", saved = "http://x"))
  }

  @Test fun `debug takes the extra, then the saved one, then virvi gg`() {
    assertEquals("http://10.0.0.2:3000", resolveBaseUrl(true, "http://10.0.0.2:3000", "http://x"))
    assertEquals("http://x", resolveBaseUrl(true, null, "http://x"))
    assertEquals("https://virvi.io", resolveBaseUrl(true, null, null))
  }

  @Test fun `debug ignores anything that isn't an http url`() {
    assertEquals("http://x", resolveBaseUrl(true, "virvi.io", "http://x"))
    assertEquals("https://virvi.io", resolveBaseUrl(true, "  ", "ftp://x"))
  }
}
