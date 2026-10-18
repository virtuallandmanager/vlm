import { ElementType } from './enums/index.js';
import { Vec3 } from './types/math.js';
import { SceneElement, SceneElementInstance } from './types/elements.js';
import { ScenePreset, SceneSetting } from './types/scene.js';

// ============================================================================
// Client -> Server messages
// ============================================================================

export type ClientMessage =
  | { type: 'scene_preset_update'; data: ScenePresetUpdateData }
  | { type: 'scene_setting_update'; data: SceneSettingUpdateData }
  | { type: 'scene_change_preset'; data: { presetId: string } }
  | { type: 'scene_add_preset'; data: { name: string } }
  | { type: 'scene_clone_preset'; data: { presetId: string; name: string } }
  | { type: 'scene_delete_preset'; data: { presetId: string } }
  | { type: 'scene_video_update'; data: VideoUpdateData }
  | { type: 'scene_sound_locator'; data: { enabled: boolean } }
  | { type: 'user_message'; data: UserMessageData };

// ============================================================================
// Server -> Client messages
// ============================================================================

export type ServerMessage =
  | { type: 'scene_preset_update'; data: ScenePresetUpdateData }
  | { type: 'scene_change_preset'; data: SceneChangePresetData }
  | { type: 'scene_video_status'; data: VideoStatusData }
  | { type: 'scene_sound_locator'; data: SoundLocatorData }
  | { type: 'scene_moderator_message'; data: ModeratorMessageData }
  | { type: 'scene_moderator_crash'; data: Record<string, never> }
  | { type: 'user_message'; data: UserMessageData }
  | { type: 'send_active_users'; data: { activeUsers: ActiveUser[] } }
  | { type: 'host_joined'; data: HostData }
  | { type: 'host_left'; data: HostData }
  | { type: 'add_session_action'; data: SessionActionBroadcast }
  | { type: 'command_center_status'; data: CommandCenterStatusData }
  | { type: 'cross_world_update'; data: CrossWorldUpdateData }
  | { type: 'hud_state_update'; data: HUDStateUpdateData };

// ============================================================================
// Shared message data interfaces
// ============================================================================

export interface ScenePresetUpdateData {
  action: 'init' | 'create' | 'update' | 'updateAll' | 'delete';
  element?: ElementType;
  instance?: boolean;
  property?: string;
  id?: string;
  scenePreset?: ScenePreset;
  sceneSettings?: SceneSetting[];
  elementData?: SceneElement;
  instanceData?: SceneElementInstance;
}

export interface SceneSettingUpdateData {
  settingId?: string;
  settingType: number;
  value: Record<string, unknown>;
}

// ============================================================================
// Session data
// ============================================================================

export interface SessionActionBroadcast {
  action: string;
  metadata?: Record<string, unknown>;
  pathPoint?: PathPoint;
  displayName?: string;
  timestamp: string;
}

// ============================================================================
// Video data
// ============================================================================

export interface VideoUpdateData {
  elementId: string;
  status: string;
  url?: string;
}

export interface VideoStatusData {
  elementId: string;
  status: string;
  url?: string;
}

// ============================================================================
// Sound data
// ============================================================================

export interface SoundLocatorData {
  enabled: boolean;
}

// ============================================================================
// Moderation data
// ============================================================================

export interface ModeratorMessageData {
  message: string;
  style?: string;
}

// ============================================================================
// User messaging
// ============================================================================

export interface UserMessageData {
  messageId: string;
  data: Record<string, unknown>;
}

// ============================================================================
// Player position & path tracking
// ============================================================================

/**
 * A path point is a compact tuple:
 * [x, y, z, timestampOffset, rotX, rotY, povMode, camX, camY, camRotX, camRotY]
 */
export type PathPoint = [
  number, // x
  number, // y
  number, // z
  number, // timestamp offset (seconds from session start)
  number, // rotation x
  number, // rotation y
  number, // pov mode (-1, 0, 1, or 2)
  number, // camera x
  number, // camera y
  number, // camera rotation x
  number, // camera rotation y
];

// ============================================================================
// Preset change
// ============================================================================

export interface SceneChangePresetData {
  userId?: string;
  displayName?: string;
  sceneId: string;
  presetId: string;
}

// ============================================================================
// Active users & hosts
// ============================================================================

export interface ActiveUser {
  userId: string;
  displayName?: string;
  walletAddress?: string;
  position?: Vec3;
  platform?: string;
  role?: number;
  connectedAt: string;
}

export interface HostData {
  displayName?: string;
  connectedWallet?: string;
  userId?: string;
}

// ============================================================================
// Command center (V2 multi-world)
// ============================================================================

export interface CommandCenterStatusData {
  worlds: WorldStatus[];
  eventId?: string;
}

export interface WorldStatus {
  sceneId: string;
  sceneName: string;
  platform: string;
  visitorCount: number;
  streamStatus: 'live' | 'offline' | 'error';
  deploymentStatus: 'deployed' | 'deploying' | 'failed' | 'none';
  activePreset?: string;
  eventId?: string;
}

export interface CrossWorldUpdateData {
  sourceSceneId: string;
  targetSceneIds: string[];
  update: ScenePresetUpdateData;
}

export interface HUDStateUpdateData {
  panel?: string;
  visible?: boolean;
  state?: Record<string, unknown>;
}
