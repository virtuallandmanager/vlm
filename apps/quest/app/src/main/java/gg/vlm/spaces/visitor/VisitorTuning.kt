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
  /**
   * Tracking is taken to have jumped when the head moves more than the larger of [JUMP_DISTANCE_M] and
   * [MAX_WALK_SPEED_M_S] × the time since the last tick, or turns more than the larger of [JUMP_YAW_DEG] and
   * [MAX_TURN_DEG_S] × that time. The time counts up to [MAX_TICK_GAP_S].
   */
  const val JUMP_DISTANCE_M = 0.25
  const val JUMP_YAW_DEG = 25.0
  const val MAX_WALK_SPEED_M_S = 2.5
  const val MAX_TURN_DEG_S = 300.0
  const val MAX_TICK_GAP_S = 0.5
  /** How long a ring the server doesn't know stays on the do-not-ask list. */
  const val NOT_FOUND_RETRY_MS = 600_000L
  /** How long an unreadable candidate must persist before "Step closer". */
  const val UNREADABLE_HINT_MS = 1500L
  /** A failed lookup is retried after this long, doubling per failure up to the cap; success resets it. */
  const val LOOKUP_RETRY_MIN_MS = 2_000L
  const val LOOKUP_RETRY_MAX_MS = 30_000L
}
