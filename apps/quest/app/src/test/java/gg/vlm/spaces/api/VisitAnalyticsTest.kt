package gg.vlm.spaces.api

import gg.vlm.spaces.Vec3
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VisitAnalyticsTest {
  private var now = 1_700_000_000_000L
  private val posts = mutableListOf<Pair<String, JsonObject>>()
  /** What the server makes of the next posts; every attempt is counted. */
  private var answer = AnalyticsPost.Sent
  private var ok: Boolean
    get() = answer == AnalyticsPost.Sent
    set(v) {
      answer = if (v) AnalyticsPost.Sent else AnalyticsPost.Retry
    }
  private var attempts = 0

  private val analytics =
      VisitAnalytics(
          post = { id, body ->
            attempts++
            if (answer == AnalyticsPost.Sent) posts += id to Json.parseToJsonElement(body).jsonObject
            answer
          },
          clock = { now },
      )

  private fun events(batch: JsonObject) = batch["events"]!!.jsonArray.map { it.jsonObject }
  private fun types(batch: JsonObject) = events(batch).map { it["type"]!!.jsonPrimitive.content }

  @Test
  fun `enter, two positions 6 s apart, leave is one batch`() = runBlocking {
    analytics.shown("s1")
    analytics.position(Vec3(1.0, 1.5, 2.0))
    now += 6_000
    analytics.position(Vec3(1.5, 1.5, 2.0))
    now += 1_000
    analytics.end()
    analytics.flush()
    assertEquals(1, posts.size)
    val (id, batch) = posts[0]
    assertEquals("s1", id)
    assertEquals(JsonPrimitive(1), batch["v"])
    assertEquals("ar-quest", batch["platform"]!!.jsonPrimitive.content)
    assertEquals(listOf("enter", "pos", "pos", "leave"), types(batch))
    val e = events(batch)
    assertEquals(1_700_000_000_000L, e[0]["t"]!!.jsonPrimitive.content.toLong())
    assertEquals(1.5, e[2]["x"]!!.jsonPrimitive.content.toDouble(), 1e-9)
    assertTrue(e[0]["x"] == null && e[3]["x"] == null)
    assertEquals(1, e.map { it["playerId"]!!.jsonPrimitive.content }.toSet().size)
  }

  @Test
  fun `positions within 5 s collapse to one`() = runBlocking {
    analytics.shown("s1")
    analytics.position(Vec3(0.0, 0.0, 0.0))
    now += 2_000
    analytics.position(Vec3(1.0, 0.0, 0.0))
    now += 2_900
    analytics.position(Vec3(2.0, 0.0, 0.0))
    analytics.flush()
    assertEquals(listOf("enter", "pos"), types(posts[0].second))
  }

  @Test
  fun `hidden pauses the visit without a leave, and a re-show continues it`() = runBlocking {
    analytics.shown("s1")
    analytics.hidden()
    now += 1_000
    analytics.position(Vec3(9.0, 9.0, 9.0))
    analytics.shown("s1")
    analytics.end()
    analytics.flush()
    val e = events(posts[0].second)
    assertEquals(listOf("enter", "leave"), e.map { it["type"]!!.jsonPrimitive.content })
  }

  @Test
  fun `a failed post is retried, and the queue caps at 200`() = runBlocking {
    ok = false
    analytics.shown("s1")
    repeat(300) {
      now += 5_000
      analytics.position(Vec3(it.toDouble(), 0.0, 0.0))
    }
    analytics.flush()
    assertTrue(posts.isEmpty())
    ok = true
    analytics.flush()
    assertEquals(1, posts.size)
    val e = events(posts[0].second)
    assertEquals(200, e.size)
    assertEquals(299.0, e.last()["x"]!!.jsonPrimitive.content.toDouble(), 1e-9)
    analytics.flush()
    assertEquals(1, posts.size)
  }

  @Test
  fun `a new visit gets a new playerId`() = runBlocking {
    analytics.shown("s1")
    analytics.end()
    analytics.shown("s1")
    analytics.end()
    analytics.flush()
    val ids = posts.flatMap { events(it.second) }.map { it["playerId"]!!.jsonPrimitive.content }.toSet()
    assertEquals(2, ids.size)
    assertTrue(ids.all { it.length in 1..100 })
  }

  @Test
  fun `a different space starts a new visit and posts to its own endpoint`() = runBlocking {
    analytics.shown("s1")
    analytics.shown("s2")
    analytics.end()
    analytics.flush()
    assertEquals(listOf("s1", "s2"), posts.map { it.first })
    assertNotEquals(
        events(posts[0].second)[0]["playerId"],
        events(posts[1].second)[0]["playerId"],
    )
  }

  @Test
  fun `a batch the server refuses for good is dropped, not retried`() = runBlocking {
    answer = AnalyticsPost.Drop
    analytics.shown("gone")
    analytics.end()
    analytics.flush()
    assertEquals(1, attempts)
    answer = AnalyticsPost.Sent
    analytics.flush()
    assertEquals(1, attempts)
    assertTrue(posts.isEmpty())
  }

  @Test
  fun `a drop only drops that space's batch`() = runBlocking {
    var calls = 0
    val dropFirst =
        VisitAnalytics(
            post = { id, _ ->
              calls++
              if (id == "gone") AnalyticsPost.Drop else AnalyticsPost.Retry
            },
            clock = { now },
        )
    dropFirst.shown("gone")
    dropFirst.shown("s2")
    dropFirst.end()
    dropFirst.flush()
    assertEquals(2, calls)
    dropFirst.flush()
    assertEquals(3, calls) // only s2 is tried again
  }

  @Test
  fun `the server's answer decides between sent, retry and drop`() {
    assertEquals(AnalyticsPost.Sent, analyticsPostFor(200))
    assertEquals(AnalyticsPost.Sent, analyticsPostFor(204))
    assertEquals(AnalyticsPost.Drop, analyticsPostFor(400))
    assertEquals(AnalyticsPost.Drop, analyticsPostFor(404))
    assertEquals(AnalyticsPost.Drop, analyticsPostFor(413))
    assertEquals(AnalyticsPost.Retry, analyticsPostFor(408))
    assertEquals(AnalyticsPost.Retry, analyticsPostFor(429))
    assertEquals(AnalyticsPost.Retry, analyticsPostFor(500))
    assertEquals(AnalyticsPost.Retry, analyticsPostFor(503))
  }
}
