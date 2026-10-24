package gg.vlm.spaces.builder

import gg.vlm.spaces.Quat
import gg.vlm.spaces.Vec3
import gg.vlm.spaces.space.RootPose

/** [Hand.grips] bits: which side's grip this controller reports held. */
const val GRIP_LEFT = 1
const val GRIP_RIGHT = 2

/** [Hand.thumbs] bits: a thumbstick pushed left or right, on each side's controller. */
const val THUMB_LEFT_LEFT = 1
const val THUMB_LEFT_RIGHT = 2
const val THUMB_RIGHT_LEFT = 4
const val THUMB_RIGHT_RIGHT = 8

/** One active controller this frame: an [id] that stays the same between frames, its grip and thumbstick bits and pose. */
class Hand(val id: Any, val grips: Int, val thumbs: Int, val pose: WorldPose)

/**
 * The carry state machine behind `Picking`, free of the SDK: a grip newly pressed on a controller whose ray points at
 * the picked item takes it ([BuilderEditor.beginCarry]); every [frame] the item follows that controller (its identity
 * kept from the start), thumbstick flicks turn it [CARRY_TURN_DEGREES]; the grip letting go, or the controller going
 * missing, puts it down through [landCarried], snapped to the room unless the OTHER controller's grip is held. Losing
 * the scene [RootPose], or the item (taken by someone else), ends the carry. The gizmo's snapping (a held grip) is
 * kept off while carrying. Main thread only.
 */
class CarryController(private val editor: BuilderEditor) {
  private class Held(val id: Any, val left: Boolean, val carry: Carry, var pose: WorldPose, var thumbBits: Int)

  private var held: Held? = null
  private var lastGrips = 0

  /** A carry is under way (the pointer should leave the item alone). */
  val carrying: Boolean
    get() = held != null

  /**
   * One frame. [pointerBusy]: the pointer is pressing something, so no new carry starts. [surfaces] is read only when
   * an item lands.
   */
  fun frame(hands: List<Hand>, root: RootPose?, pointerBusy: Boolean, surfaces: () -> List<Surface>) {
    val grips = hands.fold(0) { acc, h -> acc or h.grips }
    editor.setSnap(grips != 0 && held == null)
    val h = held
    if (h != null) carryFrame(h, hands, grips, root, surfaces) else if (!pointerBusy) startCarry(hands, grips, root)
    lastGrips = grips
  }

  /** Drops a carry in progress, its last pose relayed where it is. */
  fun cancel() {
    if (held != null) editor.endDrag()
    held = null
  }

  private fun startCarry(hands: List<Hand>, grips: Int, r: RootPose?) {
    if (r == null || editor.dragging) return
    for (left in listOf(true, false)) {
      val bit = if (left) GRIP_LEFT else GRIP_RIGHT
      if (grips and bit == 0 || lastGrips and bit != 0) continue
      val hand = hands.firstOrNull { it.grips and bit != 0 } ?: continue
      val shown = editor.pickedItem()?.second ?: return
      val ray = sceneRay(hand.pose.position, hand.pose.rotation.rotate(Vec3(0.0, 0.0, 1.0)), r)
      if (!rayNearItem(ray, shown.position, carryGrabRadius(shown.scale))) continue
      val start = editor.beginCarry() ?: return
      val carry = Carry().also { it.start(worldPoseOf(start, r), hand.pose) }
      held = Held(hand.id, left, carry, hand.pose, hand.thumbs and thumbMask(left))
      return
    }
  }

  private fun carryFrame(h: Held, hands: List<Hand>, grips: Int, r: RootPose?, surfaces: () -> List<Surface>) {
    val picked = editor.pickedItem()
    if (r == null || picked == null || !editor.dragging) {
      // The scene was lost, or the item taken away; either way the editor's carry must not be left running.
      if (editor.dragging) editor.endDrag()
      held = null
      return
    }
    val (item, shown) = picked
    val gripBit = if (h.left) GRIP_LEFT else GRIP_RIGHT
    val hand = hands.firstOrNull { it.id == h.id && it.grips and gripBit != 0 }
    if (hand == null) {
      // Snapping is off while the other controller's grip is held.
      val snapOn = grips and (if (h.left) GRIP_RIGHT else GRIP_LEFT) == 0
      editor.endCarry(landCarried(h.carry.update(h.pose), item.element, shown.scale, r, surfaces(), snapOn))
      held = null
      return
    }
    val bits = hand.thumbs and thumbMask(h.left)
    val flicked = bits and h.thumbBits.inv()
    h.thumbBits = bits
    if (flicked and (if (h.left) THUMB_LEFT_RIGHT else THUMB_RIGHT_RIGHT) != 0) h.carry.turn(CARRY_TURN_DEGREES)
    if (flicked and (if (h.left) THUMB_LEFT_LEFT else THUMB_RIGHT_LEFT) != 0) h.carry.turn(-CARRY_TURN_DEGREES)
    h.pose = hand.pose
    // Live, unsnapped: the room is read only when the item lands.
    editor.carryTo(landCarried(h.carry.update(hand.pose), item.element, shown.scale, r, emptyList(), snapOn = false))
  }

  private fun thumbMask(left: Boolean) = if (left) THUMB_LEFT_LEFT or THUMB_LEFT_RIGHT else THUMB_RIGHT_LEFT or THUMB_RIGHT_RIGHT
}
