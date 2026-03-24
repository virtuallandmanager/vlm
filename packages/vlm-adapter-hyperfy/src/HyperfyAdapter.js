/**
 * HyperfyAdapter — implements VLMPlatformAdapter for Hyperfy worlds.
 *
 * Unlike DclAdapter (which calls imperative ECS APIs directly), Hyperfy uses
 * React JSX for rendering. This adapter writes to an EntityStore; a React
 * component (HyperfyRenderer) reads that store and renders the corresponding
 * Hyperfy JSX elements (<video>, <image>, <model>, <audio>).
 */

import { EntityStore } from './EntityStore.js'

// VideoState enum mirrors vlm-shared — imported as value here since this is plain JS
const VideoState = {
  NONE: 0,
  LOADING: 1,
  READY: 2,
  PLAYING: 3,
  BUFFERING: 4,
  ERROR: 5,
  SEEKING: 6,
  PAUSED: 7,
}

export class HyperfyAdapter {
  /**
   * @param {object} world — Hyperfy world instance from useWorld()
   */
  constructor(world) {
    this.world = world
    this._systems = []
  }

  // ---------------------------------------------------------------------------
  // Capabilities
  // ---------------------------------------------------------------------------

  capabilities = {
    video: true,
    spatialAudio: true,
    gltfModels: true,
    customEmotes: false,
    playerTeleport: false,
    externalUrls: true,
    nftDisplay: false,
    colliders: true,
    spatialUI: false,
    screenSpaceUI: false,
    platformName: 'hyperfy',
    platformVersion: '2',
  }

  // ---------------------------------------------------------------------------
  // Identity & Auth
  // ---------------------------------------------------------------------------

  async getPlatformUser() {
    const avatar = this.world.getAvatar?.() ?? {}
    return {
      id: avatar.id || avatar.uid || '',
      displayName: avatar.name || avatar.displayName || 'Guest',
      walletAddress: avatar.wallet || null,
      isGuest: !avatar.wallet,
    }
  }

  async getAuthProof() {
    return {
      type: 'platform-token',
      payload: { world: this.world },
    }
  }

  // ---------------------------------------------------------------------------
  // Scene Metadata
  // ---------------------------------------------------------------------------

  async getSceneInfo() {
    return {
      sceneId: '', // Overridden by VLM.init() config.sceneId
      platformSceneId: this.world.getSlug?.() || '',
      location: this.world.getSlug?.() || '',
      metadata: {
        shard: this.world.getShard?.() || '',
      },
    }
  }

  async getEnvironment() {
    return {
      isPreview: false,
      platformName: 'hyperfy',
      platformVersion: '2',
    }
  }

  // ---------------------------------------------------------------------------
  // Entity Lifecycle
  // ---------------------------------------------------------------------------

  createEntity() {
    return EntityStore.createEntity()
  }

  destroyEntity(handle) {
    EntityStore.destroyEntity(handle)
  }

  entityExists(handle) {
    return EntityStore.entityExists(handle)
  }

  // ---------------------------------------------------------------------------
  // Transform
  // ---------------------------------------------------------------------------

  setTransform(entity, transform) {
    EntityStore.updateEntity(entity, { transform })
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  setPlaneRenderer(entity) {
    EntityStore.updateEntity(entity, { type: 'plane' })
  }

  setGltfModel(entity, src) {
    EntityStore.updateEntity(entity, { type: 'model', model: { src } })
  }

  setMaterial(entity, material) {
    EntityStore.updateEntity(entity, { material })
  }

  setVideoMaterial(entity, video) {
    EntityStore.updateEntity(entity, { type: 'video', videoMaterial: video })
  }

  // ---------------------------------------------------------------------------
  // Video
  // ---------------------------------------------------------------------------

  createVideoPlayer(entity, options) {
    EntityStore.updateEntity(entity, {
      type: 'video',
      video: { ...options, state: VideoState.PLAYING },
    })
  }

  updateVideoSource(entity, src) {
    const e = EntityStore.getEntity(entity)
    if (e?.video) {
      EntityStore.updateEntity(entity, {
        video: { ...e.video, src },
      })
    }
  }

  setVideoVolume(entity, volume) {
    const e = EntityStore.getEntity(entity)
    if (e?.video) {
      EntityStore.updateEntity(entity, {
        video: { ...e.video, volume },
      })
    }
  }

  getVideoState(entity) {
    const e = EntityStore.getEntity(entity)
    return e?.video?.state ?? VideoState.NONE
  }

  // ---------------------------------------------------------------------------
  // Audio
  // ---------------------------------------------------------------------------

  setAudioSource(entity, options) {
    EntityStore.updateEntity(entity, {
      type: 'audio',
      audio: { ...options },
    })
  }

  playAudio(entity) {
    const e = EntityStore.getEntity(entity)
    if (e?.audio) {
      EntityStore.updateEntity(entity, {
        audio: { ...e.audio, playing: true },
      })
    }
  }

  stopAudio(entity) {
    const e = EntityStore.getEntity(entity)
    if (e?.audio) {
      EntityStore.updateEntity(entity, {
        audio: { ...e.audio, playing: false },
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Physics
  // ---------------------------------------------------------------------------

  setCollider(entity, options) {
    EntityStore.updateEntity(entity, { collider: options })
  }

  removeCollider(entity) {
    EntityStore.updateEntity(entity, { collider: null })
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  onPointerDown(entity, options, cb) {
    EntityStore.updateEntity(entity, {
      pointerDown: { options, callback: cb },
    })
  }

  removePointerEvents(entity) {
    EntityStore.updateEntity(entity, { pointerDown: null })
  }

  // ---------------------------------------------------------------------------
  // Player Actions
  // ---------------------------------------------------------------------------

  openUrl(url) {
    if (typeof window !== 'undefined') {
      window.open(url, '_blank')
    }
  }

  teleportPlayer(_destination) {
    // Not supported in Hyperfy
  }

  movePlayer(_position, _cameraTarget) {
    // Not supported in Hyperfy
  }

  triggerEmote(_emoteId) {
    // Not supported in Hyperfy
  }

  // ---------------------------------------------------------------------------
  // Frame Loop
  // ---------------------------------------------------------------------------

  registerSystem(update) {
    this._systems.push(update)
  }

  unregisterSystem(update) {
    this._systems = this._systems.filter((s) => s !== update)
  }

  /**
   * Called each frame by the Hyperfy world.onUpdate callback.
   * Ticks all registered systems.
   * @param {number} dt — delta time in seconds
   */
  tick(dt) {
    for (const fn of this._systems) {
      fn(dt)
    }
  }

  /**
   * Tear down — clear entity store and systems.
   */
  destroy() {
    this._systems = []
    EntityStore.clear()
  }
}
