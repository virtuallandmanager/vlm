import { Vec3, TransformData } from './types/math.js';

// ---------------------------------------------------------------------------
// Platform adapter — the single interface every metaverse platform implements
// ---------------------------------------------------------------------------

export interface VLMPlatformAdapter {
  // --- Identity & Auth ---
  /** Get the current user's platform-specific identity */
  getPlatformUser(): Promise<PlatformUser>;
  /** Get a signed authentication proof (e.g., wallet signature, platform token) */
  getAuthProof(): Promise<AuthProof>;

  // --- Scene Metadata ---
  /** Get scene metadata from the platform (ID, location, realm, etc.) */
  getSceneInfo(): Promise<SceneInfo>;
  /** Get platform environment details (preview mode, platform name, etc.) */
  getEnvironment(): Promise<PlatformEnvironment>;

  // --- Entity Lifecycle ---
  createEntity(): EntityHandle;
  destroyEntity(handle: EntityHandle): void;
  entityExists(handle: EntityHandle): boolean;

  // --- Transform ---
  setTransform(entity: EntityHandle, transform: TransformData): void;

  // --- Rendering ---
  setPlaneRenderer(entity: EntityHandle): void;
  setGltfModel(entity: EntityHandle, src: string): void;
  setMaterial(entity: EntityHandle, material: MaterialData): void;
  setVideoMaterial(entity: EntityHandle, video: VideoMaterialData): void;

  // --- Video ---
  createVideoPlayer(entity: EntityHandle, options: VideoPlayerOptions): void;
  updateVideoSource(entity: EntityHandle, src: string): void;
  setVideoVolume(entity: EntityHandle, volume: number): void;
  getVideoState(entity: EntityHandle): VideoState;

  // --- Audio ---
  setAudioSource(entity: EntityHandle, options: AudioOptions): void;
  playAudio(entity: EntityHandle): void;
  stopAudio(entity: EntityHandle): void;

  // --- Physics ---
  setCollider(entity: EntityHandle, options: ColliderOptions): void;
  removeCollider(entity: EntityHandle): void;

  // --- Input ---
  onPointerDown(
    entity: EntityHandle,
    options: PointerOptions,
    cb: PointerCallback,
  ): void;
  removePointerEvents(entity: EntityHandle): void;

  // --- Player Actions ---
  openUrl(url: string): void;
  teleportPlayer(destination: string): void;
  movePlayer(position: Vec3, cameraTarget?: Vec3): void;
  triggerEmote(emoteId: string): void;

  // --- Frame Loop ---
  registerSystem(update: (dt: number) => void): void;
  unregisterSystem(update: (dt: number) => void): void;

  // --- Capabilities ---
  readonly capabilities: PlatformCapabilities;
}

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export type EntityHandle = number | string;

export interface PlatformCapabilities {
  video: boolean;
  spatialAudio: boolean;
  gltfModels: boolean;
  customEmotes: boolean;
  playerTeleport: boolean;
  externalUrls: boolean;
  nftDisplay: boolean;
  colliders: boolean;
  spatialUI: boolean;
  screenSpaceUI: boolean;
  maxEntities?: number;
  platformName: string;
  platformVersion?: string;
}

export interface PlatformUser {
  id: string;
  displayName?: string;
  walletAddress?: string;
  isGuest: boolean;
  avatarUrl?: string;
}

export interface AuthProof {
  type: 'signed-fetch' | 'wallet-signature' | 'platform-token' | 'api-key';
  payload: Record<string, unknown>;
}

export interface SceneInfo {
  sceneId: string;
  platformSceneId?: string;
  location?: string;
  metadata?: Record<string, unknown>;
}

export interface PlatformEnvironment {
  isPreview: boolean;
  platformName: string;
  platformVersion?: string;
  realm?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Parameter types used by the adapter methods
// ---------------------------------------------------------------------------

export interface MaterialData {
  textureSrc?: string;
  bumpSrc?: string;
  emissiveSrc?: string;
  alphaSrc?: string;
  emission?: number;
  castShadows?: boolean;
  isTransparent?: boolean;
  albedoColor?: { r: number; g: number; b: number; a: number };
}

export interface VideoMaterialData {
  videoPlayerEntity: EntityHandle;
  emission?: number;
  isTransparent?: boolean;
}

export interface VideoPlayerOptions {
  src: string;
  playing?: boolean;
  volume?: number;
  loop?: boolean;
  playbackRate?: number;
}

export enum VideoState {
  NONE = 0,
  LOADING = 1,
  READY = 2,
  PLAYING = 3,
  BUFFERING = 4,
  ERROR = 5,
  SEEKING = 6,
  PAUSED = 7,
}

export interface AudioOptions {
  src: string;
  loop?: boolean;
  volume?: number;
  playing?: boolean;
  global?: boolean;
}

export interface ColliderOptions {
  type: 'box' | 'sphere' | 'mesh';
  isTrigger?: boolean;
}

export interface PointerOptions {
  hoverText?: string;
  maxDistance?: number;
  showFeedback?: boolean;
  button?: 'primary' | 'secondary' | 'action3' | 'action4' | 'action5' | 'action6';
}

export type PointerCallback = (event: PointerEventData) => void;

export interface PointerEventData {
  entityHandle: EntityHandle;
  button: string;
  origin: Vec3;
  direction: Vec3;
  hitPosition?: Vec3;
  hitNormal?: Vec3;
}
