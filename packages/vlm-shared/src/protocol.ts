import { ElementType } from './enums/index.js';
import { Vec3 } from './types/math.js';
import { SceneElement, SceneElementInstance } from './types/elements.js';
import { ScenePreset, SceneSetting } from './types/scene.js';

// ============================================================================
// Client -> Server messages
// ============================================================================

export type ClientMessage =
  | { type: 'session_start'; data: SessionStartData }
  | { type: 'session_action'; data: SessionActionData }
  | { type: 'session_end'; data: Record<string, never> }
  | { type: 'scene_preset_update'; data: ScenePresetUpdateData }
  | { type: 'scene_setting_update'; data: SceneSettingUpdateData }
  | { type: 'scene_change_preset'; data: { presetId: string } }
  | { type: 'scene_add_preset'; data: { name: string } }
  | { type: 'scene_clone_preset'; data: { presetId: string; name: string } }
  | { type: 'scene_delete_preset'; data: { presetId: string } }
  | { type: 'scene_video_update'; data: VideoUpdateData }
  | { type: 'scene_sound_locator'; data: { enabled: boolean } }
  | { type: 'giveaway_claim'; data: GiveawayClaimData }
  | { type: 'user_message'; data: UserMessageData }
  | { type: 'get_user_state'; data: { key: string } }
  | { type: 'set_user_state'; data: { key: string; value: unknown } }
  | { type: 'send_player_position'; data: PlayerPositionData }
  | { type: 'path_start'; data: PathStartData }
  | { type: 'path_segments_add'; data: PathSegmentData }
  | { type: 'path_end'; data: Record<string, never> };

// ============================================================================
// Server -> Client messages
// ============================================================================

export type ServerMessage =
  | { type: 'session_started'; data: SessionStartedData }
  | { type: 'scene_preset_update'; data: ScenePresetUpdateData }
  | { type: 'scene_change_preset'; data: SceneChangePresetData }
  | { type: 'scene_video_status'; data: VideoStatusData }
  | { type: 'scene_sound_locator'; data: SoundLocatorData }
  | { type: 'scene_moderator_message'; data: ModeratorMessageData }
  | { type: 'scene_moderator_crash'; data: Record<string, never> }
  | { type: 'giveaway_claim_response'; data: GiveawayClaimResponseData }
  | { type: 'user_message'; data: UserMessageData }
  | { type: 'get_user_state'; data: { key: string; value: unknown } }
  | { type: 'set_user_state'; data: { key: string; success: boolean } }
  | { type: 'send_active_users'; data: { activeUsers: ActiveUser[] } }
  | { type: 'request_player_position'; data: Record<string, never> }
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

export interface SessionStartData {
  sessionToken?: string;
  sceneId: string;
  userId?: string;
  displayName?: string;
  walletAddress?: string;
  isGuest: boolean;
  platform: string;
  device?: string;
  location?: string;
  realm?: string;
}

export interface SessionStartedData {
  sessionId: string;
  userId: string;
  scenePreset?: ScenePreset;
  sceneSettings?: SceneSetting[];
  role: number;
}

export interface SessionActionData {
  action: string;
  metadata?: Record<string, unknown>;
  pathPoint?: PathPoint;
  sessionToken?: string;
}

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
// Giveaway data
// ============================================================================

export interface GiveawayClaimData {
  giveawayId: string;
  claimPointId?: string;
}

export interface GiveawayClaimResponseData {
  responseType: 'success' | 'error' | 'already_claimed' | 'limit_reached' | 'not_found';
  reason?: string;
  giveawayId: string;
  itemId?: string;
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

export interface PlayerPositionData {
  position: Vec3;
  rotation?: Vec3;
  cameraPosition?: Vec3;
  cameraRotation?: Vec3;
  povMode?: number;
}

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

export interface PathStartData {
  segmentType: string;
  startPoint: PathPoint;
}

export interface PathSegmentData {
  segmentType: string;
  points: PathPoint[];
}

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
