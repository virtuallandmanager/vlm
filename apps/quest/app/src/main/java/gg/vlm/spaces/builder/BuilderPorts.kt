package gg.vlm.spaces.builder

import gg.vlm.spaces.api.BuilderCall
import gg.vlm.spaces.api.DeviceSpace
import gg.vlm.spaces.api.MarkerPose
import gg.vlm.spaces.space.RootPose
import kotlinx.serialization.json.JsonObject

// What BuilderController works through (each a fake in its tests) and what it shows.

/** The builder's calls for one space ([callsFor] in the app, a fake in tests). */
interface BuilderSpaceCalls {
  /** The editor's draft and save calls. */
  val editor: BuilderRemote

  suspend fun scene(sceneId: String): BuilderCall<JsonObject>

  suspend fun sceneSpaces(sceneId: String): BuilderCall<List<SpaceName>>

  suspend fun library(sceneId: String): BuilderCall<JsonObject>

  suspend fun place(presetId: String, entry: LibraryEntry, t: ItemTransform): BuilderCall<PlacedItem>

  suspend fun savePose(markerId: String, pose: MarkerPose, heightAboveFloorM: Double): BuilderCall<List<String>>
}

/** [BuilderApi]'s calls for [spaceId]. */
fun BuilderApi.callsFor(spaceId: String): BuilderSpaceCalls {
  val api = this
  return object : BuilderSpaceCalls {
    override val editor = api.forSpace(spaceId)

    override suspend fun scene(sceneId: String) = api.scene(spaceId, sceneId)

    override suspend fun sceneSpaces(sceneId: String) = api.sceneSpaces(spaceId, sceneId)

    override suspend fun library(sceneId: String) = api.library(spaceId, sceneId)

    override suspend fun place(presetId: String, entry: LibraryEntry, t: ItemTransform) = api.placeEntry(spaceId, presetId, entry, t)

    override suspend fun savePose(markerId: String, pose: MarkerPose, heightAboveFloorM: Double) =
        api.savePose(spaceId, markerId, pose, heightAboveFloorM)
  }
}

/** The renderer's builder side (`SceneRenderer`; a fake in tests). */
interface BuilderScene {
  /** Item meshes take pointer hits. */
  var builderMode: Boolean

  /** Edited items shown where the builder has put them, by render key. */
  fun setOverrides(next: Map<String, ItemTransform>)
}

/** The pointer, gizmo and pick outline (`HeadsetBuilderTools` on the headset; a fake in tests). */
interface BuilderTools {
  /** Starts picking and dragging [editor]'s items in the scene placed at [root]. */
  fun start(editor: BuilderEditor, root: () -> RootPose?)

  /** Call every frame while started. */
  fun tick()

  /** Lets go of anything held and removes the gizmo and outline. */
  fun stop()
}

/** The thumbsticks and grip while aligning: each is −1, 0 or 1 (left stick right/forward, right stick right); [fine] is the grip. */
data class AlignSticks(val leftX: Double = 0.0, val leftY: Double = 0.0, val rightX: Double = 0.0, val fine: Boolean = false)

/**
 * The small builder panel: a line, the spaces to choose from (none when it is only a message), and the label of its
 * button ([BuilderController.cancel]).
 */
data class BuilderPrompt(val text: String, val spaces: List<DeviceSpace> = emptyList(), val button: String = "Cancel")

/** The align panel's content while aligning. */
data class AlignUi(val state: AlignState, val notes: List<String>)

/** The ring panel's content while building, with a ring of the floor steady in view. */
data class RingCheckUi(val view: RingCheckView, val status: String?)

/** Builder copy that isn't in the plan's list (the owner may reword it; see the README). */
object BuilderCopy {
  const val FINDING_SPACES = "Finding your spaces…"
  const val CHOOSE_SPACE = "Choose a space to build"
  const val NO_SPACES = "This account has no spaces to build on yet"
  const val OFFLINE = "Can't reach vlm.gg: check the connection and try again"
  const val SPACES_FAILED = "Couldn't load your spaces: try again"
  const val COULDNT_OPEN = "Couldn't open this space for building: try again"
  const val PAIRING_ENDED = "Pairing didn't finish: tap Builder to try again"
  const val LOOK_AT_LINED_UP_RING = "Look at a ring that is already lined up on this floor"
  const val FINISH_FIRST = "Finish building first (Done) to open another space"

  fun lookAtRing(spaceName: String) = "Look at a ring of $spaceName"
}

/** The HUD's controls on [editor] (null: nothing to act on, the controls do nothing); [onTab] keeps the tab. */
class EditorHudActions(private val editor: () -> BuilderEditor?, private val onTab: (HudTab) -> Unit) : BuilderHudActions {
  override fun selectTab(tab: HudTab) = onTab(tab)

  override fun pick(sk: String) {
    editor()?.pick(sk)
  }

  override fun resetToShared(sk: String) {
    editor()?.resetToShared(sk)
  }

  override fun setMode(mode: TransformMode) {
    editor()?.setMode(mode)
  }

  override fun setScope(scope: Scope) {
    editor()?.setScope(scope)
  }

  override fun setExact(mode: TransformMode, axis: Axis, value: Double) {
    editor()?.setExact(mode, axis, value)
  }

  override fun save() {
    editor()?.save()
  }

  override fun revert() {
    editor()?.revert()
  }

  override fun done() {
    editor()?.done()
  }

  override fun confirmDone(save: Boolean) {
    editor()?.confirmDone(save)
  }

  override fun cancelDone() {
    editor()?.cancelDone()
  }
}
