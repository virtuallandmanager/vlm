import {
  engine,
  Entity,
  Transform,
  MeshRenderer,
  MeshCollider,
  Material,
  VideoPlayer,
  AudioSource,
  GltfContainer,
  ColliderLayer,
  InputAction,
  PointerEvents,
  pointerEventsSystem,
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color3 } from '@dcl/sdk/math'
import type {
  VLMPlatformAdapter,
  PlatformCapabilities,
  PlatformUser,
  AuthProof,
  SceneInfo,
  PlatformEnvironment,
  EntityHandle,
  TransformData,
  MaterialData,
  VideoMaterialData,
  VideoPlayerOptions,
  VideoState,
  AudioOptions,
  ColliderOptions,
  PointerOptions,
  PointerCallback,
  Vec3,
} from 'vlm-shared'

export class DclAdapter implements VLMPlatformAdapter {
  // Video player entities -- DCL uses a separate entity for the VideoPlayer component
  private videoPlayerEntities: Map<number, Entity> = new Map()

  readonly capabilities: PlatformCapabilities = {
    video: true,
    spatialAudio: true,
    gltfModels: true,
    customEmotes: true,
    playerTeleport: true,
    externalUrls: true,
    nftDisplay: true,
    colliders: true,
    spatialUI: false,
    screenSpaceUI: true,
    platformName: 'decentraland',
    platformVersion: '7',
  }

  // ---------------------------------------------------------------------------
  // Identity & Auth
  // ---------------------------------------------------------------------------

  async getPlatformUser(): Promise<PlatformUser> {
    // Try modern getPlayer() first (SDK 7.4+)
    try {
      const { getPlayer } = await import('@dcl/sdk/players' as any)
      const player = getPlayer?.()
      if (player) {
        return {
          id: player.userId || '',
          displayName: player.name,
          walletAddress: player.userId,
          isGuest: player.isGuest ?? true,
        }
      }
    } catch {
      // Fall through to legacy API
    }

    // Fallback to deprecated getUserData
    try {
      const { getUserData } = await import('~system/UserIdentity' as any)
      const data = await getUserData({})
      return {
        id: data.data?.userId || '',
        displayName: data.data?.displayName,
        walletAddress: data.data?.publicKey,
        isGuest: !data.data?.hasConnectedWeb3,
      }
    } catch {
      // Fall through to default
    }

    return { id: '', isGuest: true }
  }

  async getAuthProof(): Promise<AuthProof> {
    try {
      const { signedFetch } = await import('~system/SignedFetch' as any)
      return {
        type: 'signed-fetch',
        payload: { signedFetch },
      }
    } catch {
      return { type: 'api-key', payload: {} }
    }
  }

  async getSceneInfo(): Promise<SceneInfo> {
    try {
      const { getSceneInformation } = await import('~system/Runtime' as any)
      const info = await getSceneInformation({})
      const metadata = JSON.parse(info.metadataJson)
      return {
        sceneId: metadata.vlm?.sceneId || '',
        platformSceneId: info.urn,
        location: metadata.scene?.base,
        metadata: {
          parcels: metadata.scene?.parcels,
          title: metadata.display?.title,
          runtimeVersion: metadata.runtimeVersion,
        },
      }
    } catch {
      return { sceneId: '' }
    }
  }

  async getEnvironment(): Promise<PlatformEnvironment> {
    try {
      const { isPreviewMode, getPlatform, getCurrentRealm } = await import(
        '~system/EnvironmentApi' as any
      )
      const [preview, platform, realm] = await Promise.all([
        isPreviewMode({}),
        getPlatform({}),
        getCurrentRealm({}),
      ])
      return {
        isPreview: preview.isPreview,
        platformName: 'decentraland',
        platformVersion: '7',
        realm: realm.currentRealm?.serverName,
        metadata: { subPlatform: platform.platform },
      }
    } catch {
      return { isPreview: false, platformName: 'decentraland' }
    }
  }

  // ---------------------------------------------------------------------------
  // Entity Lifecycle
  // ---------------------------------------------------------------------------

  createEntity(): EntityHandle {
    return engine.addEntity()
  }

  destroyEntity(handle: EntityHandle): void {
    engine.removeEntity(handle as Entity)
    // Clean up associated video player entity
    const vpEntity = this.videoPlayerEntities.get(handle as number)
    if (vpEntity) {
      engine.removeEntity(vpEntity)
      this.videoPlayerEntities.delete(handle as number)
    }
  }

  entityExists(handle: EntityHandle): boolean {
    try {
      return (
        Transform.has(handle as Entity) ||
        engine.getEntityState(handle as Entity) !== undefined
      )
    } catch {
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Transform
  // ---------------------------------------------------------------------------

  setTransform(entity: EntityHandle, transform: TransformData): void {
    const { position, rotation, scale } = transform
    Transform.createOrReplace(entity as Entity, {
      position: Vector3.create(position.x, position.y, position.z),
      rotation: Quaternion.fromEulerDegrees(rotation.x, rotation.y, rotation.z),
      scale: Vector3.create(scale.x, scale.y, scale.z),
    })
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  setPlaneRenderer(entity: EntityHandle): void {
    MeshRenderer.setPlane(entity as Entity, [
      // North side UVs
      0, 0, 0, 1, 1, 1, 1, 0,
      // South side UVs
      0, 0, 0, 1, 1, 1, 1, 0,
    ])
  }

  setGltfModel(entity: EntityHandle, src: string): void {
    GltfContainer.createOrReplace(entity as Entity, { src })
  }

  setMaterial(entity: EntityHandle, material: MaterialData): void {
    const texture = material.textureSrc
      ? Material.Texture.Common({ src: material.textureSrc })
      : undefined

    Material.setPbrMaterial(entity as Entity, {
      texture,
      emissiveTexture: texture,
      emissiveIntensity: material.emission ?? 0.6,
      emissiveColor: Color3.White(),
      roughness: 1.0,
      metallic: 0,
      specularIntensity: 0,
      transparencyMode: material.isTransparent ? 2 : 0, // ALPHA_TEST_AND_BLEND or OPAQUE
    })
  }

  setVideoMaterial(entity: EntityHandle, video: VideoMaterialData): void {
    const vpEntity = video.videoPlayerEntity as Entity
    const videoTexture = Material.Texture.Video({ videoPlayerEntity: vpEntity })

    Material.setPbrMaterial(entity as Entity, {
      texture: videoTexture,
      emissiveTexture: videoTexture,
      emissiveIntensity: video.emission ?? 0.6,
      emissiveColor: Color3.White(),
      roughness: 1.0,
      metallic: 0,
      specularIntensity: 0,
    })
  }

  // ---------------------------------------------------------------------------
  // Video
  // ---------------------------------------------------------------------------

  createVideoPlayer(entity: EntityHandle, options: VideoPlayerOptions): void {
    // DCL needs a separate entity for the VideoPlayer component.
    // The video texture is then applied to the display entity's material.
    let vpEntity = this.videoPlayerEntities.get(entity as number)
    if (!vpEntity) {
      vpEntity = engine.addEntity()
      this.videoPlayerEntities.set(entity as number, vpEntity)
    }

    VideoPlayer.createOrReplace(vpEntity, {
      src: options.src || '',
      playing: options.playing ?? true,
      volume: options.volume ?? 1,
      loop: options.loop ?? false,
      playbackRate: options.playbackRate ?? 1,
    })

    // Apply video texture to the display entity
    const videoTexture = Material.Texture.Video({ videoPlayerEntity: vpEntity })
    Material.setPbrMaterial(entity as Entity, {
      texture: videoTexture,
      emissiveTexture: videoTexture,
      emissiveIntensity: 0.6,
      emissiveColor: Color3.White(),
      roughness: 1.0,
      metallic: 0,
      specularIntensity: 0,
    })
  }

  updateVideoSource(entity: EntityHandle, src: string): void {
    const vpEntity = this.videoPlayerEntities.get(entity as number)
    if (vpEntity) {
      const vp = VideoPlayer.getMutableOrNull(vpEntity)
      if (vp) {
        vp.src = src
        vp.playing = true
      }
    }
  }

  setVideoVolume(entity: EntityHandle, volume: number): void {
    const vpEntity = this.videoPlayerEntities.get(entity as number)
    if (vpEntity) {
      const vp = VideoPlayer.getMutableOrNull(vpEntity)
      if (vp) {
        vp.volume = volume
      }
    }
  }

  getVideoState(entity: EntityHandle): VideoState {
    // DCL does not expose video state directly via a simple getter.
    // Return PLAYING as default if a video player exists on the mapped entity.
    const vpEntity = this.videoPlayerEntities.get(entity as number)
    if (vpEntity && VideoPlayer.has(vpEntity)) {
      return 3 // VideoState.PLAYING
    }
    return 0 // VideoState.NONE
  }

  // ---------------------------------------------------------------------------
  // Audio
  // ---------------------------------------------------------------------------

  setAudioSource(entity: EntityHandle, options: AudioOptions): void {
    AudioSource.createOrReplace(entity as Entity, {
      audioClipUrl: options.src,
      playing: options.playing ?? false,
      loop: options.loop ?? false,
      volume: options.volume ?? 1,
    })
  }

  playAudio(entity: EntityHandle): void {
    const audio = AudioSource.getMutableOrNull(entity as Entity)
    if (audio) audio.playing = true
  }

  stopAudio(entity: EntityHandle): void {
    const audio = AudioSource.getMutableOrNull(entity as Entity)
    if (audio) audio.playing = false
  }

  // ---------------------------------------------------------------------------
  // Physics
  // ---------------------------------------------------------------------------

  setCollider(entity: EntityHandle, options: ColliderOptions): void {
    const layers = options.isTrigger
      ? [ColliderLayer.CL_POINTER]
      : [ColliderLayer.CL_PHYSICS]

    switch (options.type) {
      case 'box':
        MeshCollider.setBox(entity as Entity, layers)
        break
      case 'sphere':
        MeshCollider.setSphere(entity as Entity, layers)
        break
      case 'mesh':
        MeshCollider.setPlane(entity as Entity, layers)
        break
    }
  }

  removeCollider(entity: EntityHandle): void {
    try {
      MeshCollider.deleteFrom(entity as Entity)
    } catch {
      // Entity may not have a collider
    }
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  onPointerDown(
    entity: EntityHandle,
    options: PointerOptions,
    cb: PointerCallback,
  ): void {
    pointerEventsSystem.onPointerDown(
      {
        entity: entity as Entity,
        opts: {
          button: InputAction.IA_POINTER,
          hoverText: options.hoverText || '',
          showFeedback: options.showFeedback ?? true,
        },
      },
      () => {
        cb({
          entityHandle: entity,
          button: 'primary',
          origin: { x: 0, y: 0, z: 0 },
          direction: { x: 0, y: 0, z: 1 },
        })
      },
    )
  }

  removePointerEvents(entity: EntityHandle): void {
    try {
      if (PointerEvents.has(entity as Entity)) {
        pointerEventsSystem.removeOnPointerDown(entity as Entity)
      }
    } catch {
      // Entity may not have pointer events
    }
  }

  // ---------------------------------------------------------------------------
  // Player Actions
  // ---------------------------------------------------------------------------

  async openUrl(url: string): Promise<void> {
    try {
      const { openExternalUrl } = await import(
        '~system/RestrictedActions' as any
      )
      openExternalUrl({ url })
    } catch {
      // Not available outside DCL runtime
    }
  }

  async teleportPlayer(destination: string): Promise<void> {
    try {
      const { requestTeleport } = await import(
        '~system/UserActionModule' as any
      )
      requestTeleport({ destination })
    } catch {
      // Not available outside DCL runtime
    }
  }

  async movePlayer(
    position: Vec3,
    cameraTarget?: Vec3,
  ): Promise<void> {
    try {
      const { movePlayerTo } = await import(
        '~system/RestrictedActions' as any
      )
      const opts: any = {
        newRelativePosition: Vector3.create(
          position.x,
          position.y,
          position.z,
        ),
      }
      if (cameraTarget) {
        opts.cameraTarget = Vector3.create(
          cameraTarget.x,
          cameraTarget.y,
          cameraTarget.z,
        )
      }
      movePlayerTo(opts)
    } catch {
      // Not available outside DCL runtime
    }
  }

  async triggerEmote(emoteId: string): Promise<void> {
    try {
      const { triggerEmote } = await import(
        '~system/RestrictedActions' as any
      )
      triggerEmote({ predefinedEmote: emoteId })
    } catch {
      // Not available outside DCL runtime
    }
  }

  // ---------------------------------------------------------------------------
  // Frame Loop
  // ---------------------------------------------------------------------------

  registerSystem(update: (dt: number) => void): void {
    engine.addSystem(update)
  }

  unregisterSystem(update: (dt: number) => void): void {
    engine.removeSystem(update)
  }
}
