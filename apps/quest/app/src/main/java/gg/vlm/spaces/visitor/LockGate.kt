package gg.vlm.spaces.visitor

enum class Gate { GATHERING, TOO_FAR, STEADY }

/** Decides whether a ring's averaged pose is good enough to place the scene from. */
object LockGate {
  fun evaluate(count: Int, spreadM: Double, headingSpreadDeg: Double, distanceM: Double): Gate =
      when {
        !spreadM.isFinite() || !headingSpreadDeg.isFinite() || !distanceM.isFinite() -> Gate.GATHERING
        count < VisitorTuning.MIN_FRAMES -> Gate.GATHERING
        distanceM > VisitorTuning.MAX_LOCK_DISTANCE_M -> Gate.TOO_FAR
        spreadM > VisitorTuning.MAX_SPREAD_M || headingSpreadDeg > VisitorTuning.MAX_HEADING_SPREAD_DEG -> Gate.GATHERING
        else -> Gate.STEADY
      }
}
