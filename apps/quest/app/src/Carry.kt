package gg.vlm.spaces.builder

import gg.vlm.spaces.Quat
import gg.vlm.spaces.Vec3
import gg.vlm.spaces.builder.TransformMath.add
import gg.vlm.spaces.builder.TransformMath.dot
import gg.vlm.spaces.builder.TransformMath.eulerDegreesToQuat
import gg.vlm.spaces.builder.TransformMath.length
import gg.vlm.spaces.builder.TransformMath.quatToEulerDegrees
import gg.vlm.spaces.builder.TransformMath.scale
import gg.vlm.spaces.builder.TransformMath.sub
import gg.vlm.spaces.space.RootPose
import gg.vlm.spaces.space.rotateY

/** A thumbstick flick while carrying turns the item this far. */
const val CARRY_TURN_DEGREES = 15.0

/** A grip starts a carry when the controller's ray passes within the item's half diagonal plus this. */
const val CARRY_GRAB_SLACK_M = 0.25

/** A position and turn in world space. */
data class WorldPose(val position: Vec3, val rotation: Quat)

private fun conjugate(q: Quat) = Quat(q.w, -q.x, -q.y, -q.z)

private fun yawQuat(deg: Double) = Quat.axisAngle(0.0, 1.0, 0.0, Math.toRadians(deg))

/**
 * Carrying an item with a controller: the item keeps the offset (and relative turn) it had from the controller when
 * [start]ed, so it moves and turns with the controller as if held. [turn] adds a turn about the vertical axis on top.
 * Pure; everything is in world space.
 */
class Carry {
  private var offset = Vec3(0.0, 0.0, 0.0)
  private var relative = Quat.IDENTITY
  private var extraYawDeg = 0.0

  fun start(itemWorld: WorldPose, controllerWorld: WorldPose) {
    val inverse = conjugate(controllerWorld.rotation)
    offset = inverse.rotate(sub(itemWorld.position, controllerWorld.position))
    relative = inverse * itemWorld.rotation
    extraYawDeg = 0.0
  }

  /** Turns the carried item [deg] more about the vertical axis, where it is. */
  fun turn(deg: Double) {
    extraYawDeg += deg
  }

  fun update(controllerWorld: WorldPose): WorldPose =
      WorldPose(
          add(controllerWorld.position, controllerWorld.rotation.rotate(offset)),
          yawQuat(extraYawDeg) * controllerWorld.rotation * relative,
      )
}

/** Where a scene [ItemTransform] sits in world space, the scene placed at [root]. */
fun worldPoseOf(t: ItemTransform, root: RootPose): WorldPose =
    WorldPose(add(root.position, rotateY(root.yawDeg, t.position)), yawQuat(root.yawDeg) * eulerDegreesToQuat(t.rotation))

/** This world pose as a scene transform under [root], with the item's [scale]. */
fun WorldPose.toScene(root: RootPose, scale: Vec3): ItemTransform =
    ItemTransform(
        rotateY(-root.yawDeg, sub(position, root.position)),
        quatToEulerDegrees(yawQuat(-root.yawDeg) * rotation),
        scale,
    )

/**
 * A carried [pose] put down: its scene transform, snapped to [surfaces] when [snapOn] (see [snap]). A wall also stands
 * the item upright (no pitch or roll) so it lies flush; a floor or table keeps the item's turn.
 */
fun landCarried(
    pose: WorldPose,
    element: String,
    scale: Vec3,
    root: RootPose,
    surfaces: List<Surface>,
    snapOn: Boolean,
): ItemTransform {
  val t = pose.toScene(root, scale)
  if (!snapOn) return t
  val e = snapExtents(element, scale)
  val r = snap(pose.position, t.rotation.y + root.yawDeg, e.halfDepth, e.halfHeight, surfaces)
  val kind = r.snappedTo ?: return t
  val position = rotateY(-root.yawDeg, sub(r.position, root.position))
  val rotation = if (kind == SurfaceKind.WALL) Vec3(0.0, ((r.yawDeg - root.yawDeg) % 360.0 + 360.0) % 360.0, 0.0) else t.rotation
  return t.copy(position = position, rotation = rotation)
}

/** True when [ray] passes within [radius] of [centre] in front of its origin. */
fun rayNearItem(ray: Ray, centre: Vec3, radius: Double): Boolean {
  val toItem = sub(centre, ray.origin)
  val along = dot(toItem, ray.direction)
  if (along < 0) return false
  return length(sub(toItem, scale(ray.direction, along))) <= radius
}

/** How near the controller's ray must pass to an item (at [s]) for a grip to take it. */
fun carryGrabRadius(s: Vec3): Double = 0.5 * length(s) + CARRY_GRAB_SLACK_M
