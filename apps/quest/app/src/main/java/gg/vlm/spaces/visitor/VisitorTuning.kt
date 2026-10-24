package gg.vlm.spaces.visitor

/** The numbers the range test will adjust, in one place. */
object VisitorTuning {
  /** The scene appears only when the ring is within this distance of the head. */
  const val MAX_LOCK_DISTANCE_M = 1.5
  const val MIN_FRAMES = 5
  /** Camera frames averaged per ring position and heading. */
  const val AVERAGE_FRAMES = 15
  const val MAX_SPREAD_M = 0.01
  const val MAX_HEADING_SPREAD_DEG = 1.0
  /** Head movement per tick beyond which tracking is taken to have jumped. */
  const val JUMP_DISTANCE_M = 0.25
  const val JUMP_YAW_DEG = 25.0
  /** How long a ring the server doesn't know stays on the do-not-ask list. */
  const val NOT_FOUND_RETRY_MS = 600_000L
  /** How long an unreadable candidate must persist before "Step closer". */
  const val UNREADABLE_HINT_MS = 1500L
  /** A failed lookup is retried after this long, doubling per failure up to the cap; success resets it. */
  const val LOOKUP_RETRY_MIN_MS = 2_000L
  const val LOOKUP_RETRY_MAX_MS = 30_000L
}
