package io.virvi.ar.builder

import io.virvi.ar.api.DeviceKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BuilderSessionTest {
  private var now = 0L
  private fun session(kind: DeviceKind) = BuilderSession(kind) { now }
  private fun minutes(m: Long) = m * 60_000L
  private fun seconds(s: Long) = s * 1_000L

  @Test fun personalBackAfterNineMinutesResumesWithDrafts() {
    val s = session(DeviceKind.PERSONAL)
    s.headsetOff()
    now += minutes(9)
    assertEquals(Resume.RESUME_WITH_DRAFTS, s.headsetOn())
  }

  @Test fun personalBackAfterElevenMinutesExpiresDrafts() {
    val s = session(DeviceKind.PERSONAL)
    s.headsetOff()
    now += minutes(11)
    assertEquals(Resume.RESUME_DRAFTS_EXPIRED, s.headsetOn())
    // still signed in
    s.headsetOff()
    now += seconds(30)
    assertEquals(Resume.RESUME_WITH_DRAFTS, s.headsetOn())
  }

  @Test fun sharedBackAfterOneMinuteResumesWithDrafts() {
    val s = session(DeviceKind.SHARED)
    s.headsetOff()
    now += minutes(1)
    assertEquals(Resume.RESUME_WITH_DRAFTS, s.headsetOn())
  }

  @Test fun sharedBackAfterThreeMinutesIsSignedOut() {
    val s = session(DeviceKind.SHARED)
    s.headsetOff()
    now += minutes(3)
    assertEquals(Resume.SIGNED_OUT, s.headsetOn())
    assertEquals(Resume.SIGNED_OUT, s.headsetOn())
  }

  @Test fun sharedTickIsTrueOnceTwoMinutesHavePassedWhileOff() {
    val s = session(DeviceKind.SHARED)
    s.headsetOff()
    now += minutes(2)
    assertFalse(s.tick())
    now += seconds(1)
    assertTrue(s.tick())
  }

  @Test fun tickIsFalseWhileOnAndForPersonal() {
    val shared = session(DeviceKind.SHARED)
    now += minutes(5)
    assertFalse(shared.tick())
    val personal = session(DeviceKind.PERSONAL)
    personal.headsetOff()
    now += minutes(30)
    assertFalse(personal.tick())
  }

  @Test fun offTimeIsClearedWhenHeadsetComesBackOn() {
    val s = session(DeviceKind.SHARED)
    s.headsetOff()
    now += minutes(1)
    s.headsetOn()
    now += minutes(5)
    assertFalse(s.tick())
    assertEquals(Resume.RESUME_WITH_DRAFTS, s.headsetOn())
  }

  @Test fun headsetOnWhileAlreadyOnResumesWithDrafts() {
    val s = session(DeviceKind.SHARED)
    now += minutes(10)
    assertEquals(Resume.RESUME_WITH_DRAFTS, s.headsetOn())
  }

  @Test fun repeatedHeadsetOffKeepsTheFirstOffTime() {
    val s = session(DeviceKind.SHARED)
    s.headsetOff()
    now += minutes(1)
    s.headsetOff()
    now += seconds(90)
    assertEquals(Resume.SIGNED_OUT, s.headsetOn())
  }

  @Test fun doneEndsTheSession() {
    val s = session(DeviceKind.SHARED)
    s.done()
    assertEquals(Resume.SIGNED_OUT, s.headsetOn())
  }

  @Test fun signOutEndsThePersonalSession() {
    val s = session(DeviceKind.PERSONAL)
    s.signOut()
    s.headsetOff()
    now += minutes(1)
    assertEquals(Resume.SIGNED_OUT, s.headsetOn())
  }
}
