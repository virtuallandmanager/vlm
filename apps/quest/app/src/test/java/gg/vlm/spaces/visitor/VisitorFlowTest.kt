package gg.vlm.spaces.visitor

import gg.vlm.spaces.Vec3
import gg.vlm.spaces.api.ApiResult
import gg.vlm.spaces.api.ArFeedSnapshot
import gg.vlm.spaces.api.ArFloor
import gg.vlm.spaces.api.ArMarker
import gg.vlm.spaces.api.ArSpace
import gg.vlm.spaces.api.FeedStatus
import gg.vlm.spaces.api.MarkerLookup
import gg.vlm.spaces.api.MarkerPose
import gg.vlm.spaces.ring.RingCodec
import gg.vlm.spaces.space.rootFromMarker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VisitorFlowTest {
  private val ringA = 0x1D2C3B4AL
  private val ringA2 = 0x1D2C3B4BL
  private val ringOther = 0x2E3D4C5BL
  private val pose = MarkerPose(1.0, 1.5, 2.0, 90.0)
  private val t0 = 1_000_000L

  private fun marker(id: String, ring: Long, p: MarkerPose? = pose) = ArMarker(id, ring, RingCodec.codeOf(ring), 140.0, null, p)

  private fun space(id: String = "sp-a", rings: List<ArMarker> = listOf(marker("m1", ringA), marker("m2", ringA2))) =
      ArSpace(id, "Cafe $id", null, true, listOf(ArFloor("f1", "Ground", 0.0, 0, rings)))

  private fun snap(s: ArSpace = space(), v: String = "1") = ArFeedSnapshot(v, s, null)

  private fun lookupOk(spaceId: String = "sp-a") =
      ApiResult.Ok(MarkerLookup(spaceId, "f1", "m1", "Cafe $spaceId", null))

  private val flow = VisitorFlow()
  private var now = t0

  private fun on(e: VisitorEvent): List<VisitorEffect> = flow.on(e, now)

  private fun toLocking(s: ArSpace = space()) {
    on(VisitorEvent.RingAgreed(ringA))
    on(VisitorEvent.Lookup(RingCodec.codeOf(ringA), lookupOk(s.id)))
    on(VisitorEvent.Feed(snap(s)))
  }

  private fun toShown(s: ArSpace = space()) {
    toLocking(s)
    on(VisitorEvent.Steady(ringA, Vec3(0.0, 1.5, 0.0), 10.0))
  }

  @Test fun `starts on the hint`() = assertEquals(VisitorState.Hint, flow.state)

  @Test fun `an agreed ring while searching looks the space up by its code`() {
    val fx = on(VisitorEvent.RingAgreed(ringA))
    assertEquals(listOf<VisitorEffect>(VisitorEffect.Lookup(RingCodec.codeOf(ringA))), fx)
    assertEquals(VisitorState.Loading(RingCodec.codeOf(ringA), null), flow.state)
  }

  @Test fun `a second agreement while loading does not look up again`() {
    on(VisitorEvent.RingAgreed(ringA))
    assertTrue(on(VisitorEvent.RingAgreed(ringA)).isEmpty())
  }

  @Test fun `a found lookup starts the feed and names the space`() {
    on(VisitorEvent.RingAgreed(ringA))
    val fx = on(VisitorEvent.Lookup(RingCodec.codeOf(ringA), lookupOk()))
    assertEquals(listOf<VisitorEffect>(VisitorEffect.StartFeed("sp-a")), fx)
    assertEquals(VisitorState.Loading(RingCodec.codeOf(ringA), "Cafe sp-a"), flow.state)
  }

  @Test fun `a not found ring is not asked again until the retry time passes`() {
    on(VisitorEvent.RingAgreed(ringOther))
    on(VisitorEvent.Lookup(RingCodec.codeOf(ringOther), ApiResult.NotFound))
    assertEquals(VisitorState.Failed(VisitorCopy.NOT_OPEN), flow.state)
    now += VisitorTuning.NOT_FOUND_RETRY_MS - 1
    assertTrue(on(VisitorEvent.RingAgreed(ringOther)).isEmpty())
    // a different ring is still looked up
    assertEquals(1, on(VisitorEvent.RingAgreed(ringA)).size)
    on(VisitorEvent.Lookup(RingCodec.codeOf(ringA), ApiResult.NotFound))
    now += 1
    assertEquals(
        listOf<VisitorEffect>(VisitorEffect.Lookup(RingCodec.codeOf(ringOther))),
        on(VisitorEvent.RingAgreed(ringOther)),
    )
  }

  @Test fun `a lookup that fails shows a plain message and retries only after the backoff`() {
    on(VisitorEvent.RingAgreed(ringA))
    on(VisitorEvent.Lookup(RingCodec.codeOf(ringA), ApiResult.Offline))
    assertEquals(VisitorState.Failed(VisitorCopy.OFFLINE), flow.state)
    now += VisitorTuning.LOOKUP_RETRY_MIN_MS - 1
    assertTrue(on(VisitorEvent.RingAgreed(ringA)).isEmpty())
    assertEquals(VisitorState.Failed(VisitorCopy.OFFLINE), flow.state)
    now += 1
    assertEquals(
        listOf<VisitorEffect>(VisitorEffect.Lookup(RingCodec.codeOf(ringA))),
        on(VisitorEvent.RingAgreed(ringA)),
    )
  }

  @Test fun `the retry delay doubles up to the cap and success resets it`() {
    val code = RingCodec.codeOf(ringA)
    var delay = VisitorTuning.LOOKUP_RETRY_MIN_MS
    repeat(8) {
      assertEquals(1, on(VisitorEvent.RingAgreed(ringA)).size)
      on(VisitorEvent.Lookup(code, ApiResult.RateLimited))
      now += delay - 1
      assertTrue(on(VisitorEvent.RingAgreed(ringA)).isEmpty())
      now += 1
      delay = minOf(delay * 2, VisitorTuning.LOOKUP_RETRY_MAX_MS)
    }
    assertEquals(VisitorTuning.LOOKUP_RETRY_MAX_MS, delay)
    assertEquals(1, on(VisitorEvent.RingAgreed(ringA)).size)
    on(VisitorEvent.Lookup(code, lookupOk()))
    on(VisitorEvent.LookAgain)
    on(VisitorEvent.RingAgreed(ringA))
    on(VisitorEvent.Lookup(code, ApiResult.Offline))
    now += VisitorTuning.LOOKUP_RETRY_MIN_MS
    assertEquals(1, on(VisitorEvent.RingAgreed(ringA)).size)
  }

  @Test fun `a ring the server doesn't know says the space isn't open and stays that way`() {
    on(VisitorEvent.RingAgreed(ringOther))
    on(VisitorEvent.Lookup(RingCodec.codeOf(ringOther), ApiResult.NotFound))
    assertEquals(VisitorState.Failed(VisitorCopy.NOT_OPEN), flow.state)
    assertTrue(on(VisitorEvent.RingAgreed(ringOther)).isEmpty())
    assertEquals(VisitorState.Failed(VisitorCopy.NOT_OPEN), flow.state)
  }

  @Test fun `after an unpublish mid-visit the message survives the ring being seen again`() {
    toShown()
    on(VisitorEvent.FeedStatus(FeedStatus.NOT_FOUND))
    on(VisitorEvent.RingAgreed(ringA))
    on(VisitorEvent.Lookup(RingCodec.codeOf(ringA), ApiResult.NotFound))
    assertEquals(VisitorState.Failed(VisitorCopy.NOT_OPEN), flow.state)
  }

  @Test fun `an answer for an earlier ring is dropped when a space was opened by code`() {
    on(VisitorEvent.RingAgreed(ringA))
    on(VisitorEvent.OpenSpace("ABC123"))
    assertTrue(on(VisitorEvent.Lookup(RingCodec.codeOf(ringA), lookupOk("sp-a"))).isEmpty())
    assertEquals(VisitorState.Loading("ABC123", null), flow.state)
    assertEquals(1, on(VisitorEvent.Lookup("ABC123", lookupOk("sp-b"))).size)
  }

  @Test fun `an answer for an earlier opened code is dropped`() {
    on(VisitorEvent.OpenSpace("BBBB"))
    on(VisitorEvent.OpenSpace("CCCC"))
    assertTrue(on(VisitorEvent.Lookup("BBBB", lookupOk("sp-b"))).isEmpty())
    assertEquals(VisitorState.Loading("CCCC", null), flow.state)
    assertEquals(listOf<VisitorEffect>(VisitorEffect.StartFeed("sp-c")), on(VisitorEvent.Lookup("CCCC", lookupOk("sp-c"))))
  }

  @Test fun `lookup failures have their own words`() {
    on(VisitorEvent.RingAgreed(ringA))
    on(VisitorEvent.Lookup(RingCodec.codeOf(ringA), ApiResult.RateLimited))
    assertEquals(VisitorState.Failed(VisitorCopy.BUSY), flow.state)
    now += VisitorTuning.LOOKUP_RETRY_MAX_MS
    on(VisitorEvent.RingAgreed(ringA))
    on(VisitorEvent.Lookup(RingCodec.codeOf(ringA), ApiResult.Failed(500)))
    assertEquals(VisitorState.Failed(VisitorCopy.COULDNT_OPEN), flow.state)
    now += VisitorTuning.LOOKUP_RETRY_MAX_MS
    on(VisitorEvent.RingAgreed(ringA))
    on(VisitorEvent.Lookup(RingCodec.codeOf(ringA), ApiResult.Failed(200)))
    assertEquals(VisitorState.Failed(VisitorCopy.BAD_DATA), flow.state)
  }

  @Test fun `a stale lookup answer is ignored`() {
    on(VisitorEvent.RingAgreed(ringA))
    on(VisitorEvent.LookAgain)
    assertTrue(on(VisitorEvent.Lookup(RingCodec.codeOf(ringA), lookupOk())).isEmpty())
    assertEquals(VisitorState.Hint, flow.state)
  }

  @Test fun `the first snapshot registers only the space's rings`() {
    on(VisitorEvent.RingAgreed(ringA))
    on(VisitorEvent.Lookup(RingCodec.codeOf(ringA), lookupOk()))
    val s = space()
    val fx = on(VisitorEvent.Feed(snap(s)))
    assertEquals(listOf<VisitorEffect>(VisitorEffect.SetRegistered(setOf(ringA, ringA2))), fx)
    assertEquals(VisitorState.Locking(s), flow.state)
  }

  @Test fun `a steady ring with a pose shows the scene and flashes the outline`() {
    toLocking()
    val fx = on(VisitorEvent.Steady(ringA, Vec3(0.0, 1.5, 0.0), 10.0))
    val root = rootFromMarker(Vec3(0.0, 1.5, 0.0), 10.0, pose)
    assertEquals(listOf(VisitorEffect.ShowScene(root), VisitorEffect.FlashOutline(ringA)), fx)
    assertEquals(VisitorState.Shown(space(), root), flow.state)
  }

  @Test fun `a later steady ring of the space re-anchors`() {
    toShown()
    val fx = on(VisitorEvent.Steady(ringA2, Vec3(3.0, 1.5, 0.0), 40.0))
    val root = rootFromMarker(Vec3(3.0, 1.5, 0.0), 40.0, pose)
    assertEquals(listOf<VisitorEffect>(VisitorEffect.Reanchor(root)), fx)
    assertEquals(VisitorState.Shown(space(), root), flow.state)
  }

  @Test fun `a ring from another space doesn't re-anchor or swap`() {
    toShown()
    val before = flow.state
    assertTrue(on(VisitorEvent.RingAgreed(ringOther)).isEmpty())
    assertTrue(on(VisitorEvent.Steady(ringOther, Vec3(9.0, 1.5, 9.0), 0.0)).isEmpty())
    assertEquals(before, flow.state)
  }

  @Test fun `an unaligned ring says not set up`() {
    val s = space(rings = listOf(marker("m1", ringA, null)))
    toLocking(s)
    val fx = on(VisitorEvent.Steady(ringA, Vec3(0.0, 1.5, 0.0), 10.0))
    assertTrue(fx.isEmpty())
    assertEquals(VisitorState.NotSetUp(s.name), flow.state)
  }

  @Test fun `a tracking jump hides the scene and goes back to locking`() {
    toShown()
    val fx = on(VisitorEvent.TrackingJump)
    // at once, not faded: the scene is at the pre-jump root
    assertEquals(listOf(VisitorEffect.HideNow, VisitorEffect.ResetAveragers), fx)
    assertEquals(VisitorState.Locking(space()), flow.state)
    // the next steady ring shows it again
    assertTrue(on(VisitorEvent.Steady(ringA, Vec3(0.0, 1.5, 0.0), 10.0)).first() is VisitorEffect.ShowScene)
  }

  @Test fun `taking the headset off hides the scene until a ring is seen again`() {
    toShown()
    assertEquals(listOf(VisitorEffect.HideNow, VisitorEffect.ResetAveragers), on(VisitorEvent.HeadsetOff))
    assertTrue(on(VisitorEvent.HeadsetOn).none { it is VisitorEffect.ShowScene })
    assertTrue(on(VisitorEvent.Steady(ringA, Vec3(0.0, 1.5, 0.0), 10.0)).any { it is VisitorEffect.ShowScene })
  }

  @Test fun `look at the ring again forgets the space`() {
    toShown()
    val fx = on(VisitorEvent.LookAgain)
    assertEquals(
        setOf<VisitorEffect>(
            VisitorEffect.HideScene,
            VisitorEffect.ResetAveragers,
            VisitorEffect.StopFeed,
            VisitorEffect.SetRegistered(null),
        ),
        fx.toSet(),
    )
    assertEquals(VisitorState.Hint, flow.state)
    // searching again: a ring of the old space is looked up afresh
    assertEquals(1, on(VisitorEvent.RingAgreed(ringA)).size)
  }

  @Test fun `look again drops a failed lookup's backoff so the ring is asked again at once`() {
    on(VisitorEvent.RingAgreed(ringA))
    on(VisitorEvent.Lookup(RingCodec.codeOf(ringA), ApiResult.Offline))
    on(VisitorEvent.LookAgain)
    assertEquals(VisitorState.Hint, flow.state)
    assertEquals(
        listOf<VisitorEffect>(VisitorEffect.Lookup(RingCodec.codeOf(ringA))),
        on(VisitorEvent.RingAgreed(ringA)),
    )
    // and the backoff starts again from the minimum
    on(VisitorEvent.Lookup(RingCodec.codeOf(ringA), ApiResult.Offline))
    now += VisitorTuning.LOOKUP_RETRY_MIN_MS
    assertEquals(1, on(VisitorEvent.RingAgreed(ringA)).size)
  }

  @Test fun `opening a space clears the current one and looks the code up`() {
    toShown()
    val fx = on(VisitorEvent.OpenSpace("ABC123"))
    assertTrue(fx.containsAll(listOf(VisitorEffect.HideScene, VisitorEffect.StopFeed, VisitorEffect.SetRegistered(null))))
    assertEquals(VisitorEffect.Lookup("ABC123"), fx.last())
    assertEquals(VisitorState.Loading("ABC123", null), flow.state)
    // the answer carries no ring of ours; it still lands
    val b = space("sp-b")
    assertEquals(listOf<VisitorEffect>(VisitorEffect.StartFeed("sp-b")), on(VisitorEvent.Lookup("ABC123", lookupOk("sp-b"))))
    // the old space's feed can no longer touch us
    assertTrue(on(VisitorEvent.Feed(snap(space("sp-a"), "9"))).isEmpty())
    on(VisitorEvent.Feed(snap(b)))
    assertEquals(VisitorState.Locking(b), flow.state)
  }

  @Test fun `opening a link while another space is shown clears it`() {
    toShown()
    val fx = on(VisitorEvent.OpenSpace("2E3D4C5"))
    assertEquals(VisitorEffect.HideScene, fx.first())
    assertTrue(VisitorEffect.StopFeed in fx)
    assertEquals(VisitorEffect.Lookup("2E3D4C5"), fx.last())
    assertEquals(VisitorState.Loading("2E3D4C5", null), flow.state)
  }

  @Test fun `feed not found fails plainly, hides the scene and stops`() {
    toShown()
    val fx = on(VisitorEvent.FeedStatus(FeedStatus.NOT_FOUND))
    assertTrue(fx.containsAll(listOf(VisitorEffect.HideScene, VisitorEffect.StopFeed, VisitorEffect.SetRegistered(null))))
    assertEquals(VisitorState.Failed(VisitorCopy.NOT_OPEN), flow.state)
  }

  @Test fun `feed not found before the first snapshot also fails and stops`() {
    on(VisitorEvent.RingAgreed(ringA))
    on(VisitorEvent.Lookup(RingCodec.codeOf(ringA), lookupOk()))
    val fx = on(VisitorEvent.FeedStatus(FeedStatus.NOT_FOUND))
    assertTrue(fx.containsAll(listOf(VisitorEffect.HideScene, VisitorEffect.StopFeed)))
    assertEquals(VisitorState.Failed(VisitorCopy.NOT_OPEN), flow.state)
  }

  @Test fun `offline before the first snapshot fails, after it the scene stays`() {
    on(VisitorEvent.RingAgreed(ringA))
    on(VisitorEvent.Lookup(RingCodec.codeOf(ringA), lookupOk()))
    on(VisitorEvent.FeedStatus(FeedStatus.OFFLINE))
    assertEquals(VisitorState.Failed(VisitorCopy.OFFLINE), flow.state)
    // it recovers when the snapshot arrives
    on(VisitorEvent.Feed(snap()))
    assertEquals(VisitorState.Locking(space()), flow.state)
    on(VisitorEvent.Steady(ringA, Vec3(0.0, 1.5, 0.0), 10.0))
    val shown = flow.state
    assertTrue(on(VisitorEvent.FeedStatus(FeedStatus.OFFLINE)).isEmpty())
    assertEquals(shown, flow.state)
  }

  @Test fun `a bad or failing feed before the first snapshot says so, after it nothing changes`() {
    on(VisitorEvent.RingAgreed(ringA))
    on(VisitorEvent.Lookup(RingCodec.codeOf(ringA), lookupOk()))
    on(VisitorEvent.FeedStatus(FeedStatus.BAD_DATA))
    assertEquals(VisitorState.Failed(VisitorCopy.BAD_DATA), flow.state)
    on(VisitorEvent.FeedStatus(FeedStatus.FAILED))
    assertEquals(VisitorState.Failed(VisitorCopy.COULDNT_OPEN), flow.state)
    on(VisitorEvent.Feed(snap()))
    on(VisitorEvent.Steady(ringA, Vec3(0.0, 1.5, 0.0), 10.0))
    val shown = flow.state
    assertTrue(on(VisitorEvent.FeedStatus(FeedStatus.BAD_DATA)).isEmpty())
    assertTrue(on(VisitorEvent.FeedStatus(FeedStatus.FAILED)).isEmpty())
    assertEquals(shown, flow.state)
  }

  @Test fun `step closer goes back to the hint when the candidate is gone`() {
    on(VisitorEvent.UnreadableSeen(now - 2000))
    assertEquals(VisitorState.StepCloser, flow.state)
    on(VisitorEvent.UnreadableGone)
    assertEquals(VisitorState.Hint, flow.state)
  }

  @Test fun `rate limited before the first snapshot says busy`() {
    on(VisitorEvent.RingAgreed(ringA))
    on(VisitorEvent.Lookup(RingCodec.codeOf(ringA), lookupOk()))
    on(VisitorEvent.FeedStatus(FeedStatus.RATE_LIMITED))
    assertEquals(VisitorState.Failed(VisitorCopy.BUSY), flow.state)
  }

  @Test fun `a newer snapshot updates the shown space and its registered rings`() {
    toShown()
    val s2 = space(rings = listOf(marker("m1", ringA), marker("m2", ringA2), marker("m3", 0x3F4E5D6CL)))
    val fx = on(VisitorEvent.Feed(snap(s2, "2")))
    assertEquals(listOf<VisitorEffect>(VisitorEffect.SetRegistered(setOf(ringA, ringA2, 0x3F4E5D6CL))), fx)
    assertEquals(s2, (flow.state as VisitorState.Shown).space)
  }

  @Test fun `step closer only after the candidate persists`() {
    on(VisitorEvent.UnreadableSeen(now - 1000))
    assertEquals(VisitorState.Hint, flow.state)
    on(VisitorEvent.UnreadableSeen(now - 1600))
    assertEquals(VisitorState.StepCloser, flow.state)
    on(VisitorEvent.UnreadableSeen(now - 100))
    assertEquals(VisitorState.Hint, flow.state)
  }

  @Test fun `an unreadable candidate does not disturb a shown scene`() {
    toShown()
    val before = flow.state
    on(VisitorEvent.UnreadableSeen(now - 5000))
    assertEquals(before, flow.state)
  }
}
