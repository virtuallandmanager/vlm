import type { VLMPlatformAdapter, VLMInitConfig, VLMStorage as VLMStorageType, HUDRenderer, BudgetLimits, Scene } from 'vlm-shared'
import { VLMHttpClient, ColyseusManager } from 'vlm-client'
import { SceneManager } from './SceneManager.js'
import { VLMStorageImpl } from './storage.js'
import { EventBus } from './events/EventBus.js'

// Default API URLs by environment
const API_URLS: Record<string, string> = {
  dev: 'http://localhost:3010',
  staging: 'https://staging-api.vlm.gg',
  prod: 'https://api.vlm.gg',
}
const WSS_URLS: Record<string, string> = {
  dev: 'ws://localhost:3010',
  staging: 'wss://staging-api.vlm.gg',
  prod: 'wss://api.vlm.gg',
}

export type VLMConnectionState =
  | 'idle'
  | 'authenticating'
  | 'authenticated'
  | 'discovering_scene'
  | 'scene_ready'
  | 'connecting'
  | 'connected'
  | 'error'

export interface VLMStateListener {
  (state: VLMConnectionState, detail?: Record<string, unknown>): void
}

export class VLM {
  private adapter: VLMPlatformAdapter
  private http: VLMHttpClient
  private colyseus: ColyseusManager
  private sceneManager: SceneManager
  private events: EventBus
  private userMessageHandlers: Map<string, (data: unknown) => void> = new Map()
  private stateListeners: Set<VLMStateListener> = new Set()
  private handlersRegistered = false
  private _connectionState: VLMConnectionState = 'idle'
  private _sceneId: string | null = null
  private _user: { id: string; displayName?: string; email?: string; role: string } | null = null
  private _scenes: Scene[] = []
  private wssUrl: string = ''
  public storage: VLMStorageType
  public hud: any | null = null // HUDManager — typed as any to avoid hard dep on vlm-hud

  constructor(adapter: VLMPlatformAdapter) {
    this.adapter = adapter
    this.http = new VLMHttpClient('')
    this.colyseus = new ColyseusManager()
    this.events = new EventBus()
    this.storage = VLMStorageImpl.create()
    this.sceneManager = new SceneManager(adapter, this.storage, this.events)
  }

  get connectionState(): VLMConnectionState { return this._connectionState }
  get sceneId(): string | null { return this._sceneId }
  get user(): typeof this._user { return this._user }
  get scenes(): Scene[] { return this._scenes }
  get httpClient(): VLMHttpClient { return this.http }

  onStateChange(listener: VLMStateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  private setState(state: VLMConnectionState, detail?: Record<string, unknown>): void {
    this._connectionState = state
    for (const listener of this.stateListeners) {
      try { listener(state, detail) } catch { /* swallow */ }
    }
  }

  /**
   * Full initialization — authenticate, discover/create scene, connect Colyseus.
   * If sceneId is provided, connects directly. If not, discovers or creates one.
   */
  async init(config: VLMInitConfig): Promise<VLMStorageType> {
    // Phase 1: Authenticate (also sets up http client and wssUrl)
    await this.authenticate(config)

    // Phase 2: Discover or use provided sceneId
    if (config.sceneId) {
      this._sceneId = config.sceneId
      this.setState('scene_ready', { sceneId: config.sceneId })
    } else {
      await this.discoverOrCreateScene()
    }

    if (!this._sceneId) {
      throw new Error('No scene available — could not discover or create one')
    }

    // Phase 3: Connect to Colyseus and load scene
    return this.connectToScene(this._sceneId)
  }

  /**
   * Phase 1: Authenticate with the VLM server using platform credentials.
   * Can be called standalone before scene discovery.
   */
  async authenticate(config: VLMInitConfig): Promise<void> {
    const env = config.env || 'prod'
    const apiUrl = config.apiUrl || API_URLS[env] || API_URLS.prod
    this.wssUrl = config.wssUrl || WSS_URLS[env] || WSS_URLS.prod
    this.http = new VLMHttpClient(apiUrl)

    this.setState('authenticating')

    try {
      const [platformUser, sceneInfo, environment] = await Promise.all([
        this.adapter.getPlatformUser(),
        this.adapter.getSceneInfo(),
        this.adapter.getEnvironment(),
      ])

      const authProof = await this.adapter.getAuthProof()
      const authResponse = await this.http.authenticateWithPlatform(authProof, {
        sceneId: config.sceneId || sceneInfo.sceneId || undefined,
        user: platformUser as unknown as Record<string, unknown>,
        world: this.adapter.capabilities.platformName,
        location: sceneInfo as unknown as Record<string, unknown>,
        environment: environment as unknown as Record<string, unknown>,
      }, this.adapter)

      this._user = authResponse.user as any
      this.setState('authenticated', { user: this._user as any })
    } catch (err) {
      this.setState('error', { error: String(err) })
      throw err
    }
  }

  /**
   * Phase 2: Discover existing scenes or auto-create one.
   * Must be called after authenticate().
   */
  async discoverOrCreateScene(): Promise<string> {
    this.setState('discovering_scene')

    try {
      const { scenes } = await this.http.getScenes()
      this._scenes = scenes

      if (scenes.length > 0) {
        // Use the most recently updated scene
        this._sceneId = scenes[0].id
        this.setState('scene_ready', { sceneId: this._sceneId, scenes, isNew: false })
        return this._sceneId
      }

      // No scenes — auto-create one
      const displayName = this._user?.displayName || 'My Scene'
      const { scene } = await this.http.createScene(`${displayName}'s Scene`)
      this._sceneId = scene.id
      this._scenes = [scene]
      this.setState('scene_ready', { sceneId: this._sceneId, scenes: [scene], isNew: true })
      return this._sceneId
    } catch (err) {
      this.setState('error', { error: String(err) })
      throw err
    }
  }

  /**
   * Phase 3: Connect to a specific scene via Colyseus.
   * Must be called after authenticate().
   */
  async connectToScene(sceneId: string): Promise<VLMStorageType> {
    this._sceneId = sceneId
    this.setState('connecting', { sceneId })

    this.colyseus.connect(this.wssUrl)

    // Register message handlers BEFORE joining
    this.registerMessageHandlers()

    return new Promise<VLMStorageType>(async (resolve, reject) => {
      try {
        this.events.on('scene_initialized', () => {
          this.setState('connected', { sceneId })
          resolve(this.storage)
        })

        const platformUser = await this.adapter.getPlatformUser()

        await this.colyseus.joinSceneRoom(sceneId, {
          sessionToken: this.http.auth.token,
          clientType: 'analytics',
          user: {
            id: this._user?.id || '',
            displayName: this._user?.displayName || platformUser.displayName,
            connectedWallet: platformUser.walletAddress,
          },
        })

        this.colyseus.send('session_start', {
          sessionToken: this.http.auth.token,
          sceneId,
        })
      } catch (err) {
        this.setState('error', { error: String(err) })
        reject(err)
      }
    })
  }

  /**
   * Select a scene from the user's existing scenes and connect to it.
   */
  async selectScene(sceneId: string): Promise<VLMStorageType> {
    return this.connectToScene(sceneId)
  }

  /**
   * Create a new scene and connect to it.
   */
  async createScene(name: string, description?: string): Promise<VLMStorageType> {
    const { scene } = await this.http.createScene(name, description)
    this._sceneId = scene.id
    this._scenes = [scene, ...this._scenes]
    this.setState('scene_ready', { sceneId: scene.id, isNew: true })
    return this.connectToScene(scene.id)
  }

  private registerMessageHandlers(): void {
    if (this.handlersRegistered) return
    this.handlersRegistered = true

    this.colyseus.onMessage('scene_preset_update', (message: unknown) => {
      this.sceneManager.handlePresetUpdate(message as any)
      if ((message as any).action === 'init') {
        this.events.emit('scene_initialized')
      }
    })

    this.colyseus.onMessage('scene_change_preset', (message: unknown) => {
      this.sceneManager.handlePresetChange(message as any)
    })

    this.colyseus.onMessage('scene_video_status', (message: unknown) => {
      this.sceneManager.handleVideoStatus(message as any)
    })

    this.colyseus.onMessage('session_started', (_message: unknown) => {})

    this.colyseus.onMessage('user_message', (message: unknown) => {
      const msg = message as any
      if (msg?.messageId && this.userMessageHandlers.has(msg.messageId)) {
        this.userMessageHandlers.get(msg.messageId)!(msg.data)
      }
    })

    this.colyseus.onMessage('get_user_state', (message: unknown) => {
      this.events.emit('state_response', message)
    })
  }

  // Public API
  async destroy(): Promise<void> {
    if (this.hud) {
      this.hud.destroy()
      this.hud = null
    }
    try { this.colyseus.send('session_end', {}) } catch { /* may not be connected */ }
    this.colyseus.leaveRoom()
    this.setState('idle')
  }

  /**
   * Initialize the in-world management HUD.
   * Can be called at any time — the HUD will reflect the current connection state.
   */
  async initHUD(renderer: HUDRenderer, budgetLimits?: BudgetLimits): Promise<void> {
    if (!this.adapter.capabilities.screenSpaceUI && !this.adapter.capabilities.spatialUI) {
      return
    }

    try {
      const { HUDManager } = await import('vlm-hud')
      const limits: BudgetLimits = budgetLimits || {
        maxFileSizeBytes: 50 * 1024 * 1024,
        maxTriangleCount: 100_000,
        maxTextureCount: 128,
        maxMaterialCount: 128,
        maxEntityCount: 500,
        platformName: this.adapter.capabilities.platformName,
      }

      this.hud = new HUDManager({
        renderer,
        http: this.http,
        colyseus: this.colyseus,
        storage: this.storage,
        budgetLimits: limits,
      })
      this.hud.init()
    } catch {
      // vlm-hud not installed — that's fine, it's optional
    }
  }

  sendMessage(id: string, data?: unknown): void {
    this.colyseus.send('user_message', { messageId: id, data, type: 'outbound' })
  }

  onMessage(id: string, callback: (data: unknown) => void): void {
    this.userMessageHandlers.set(id, callback)
  }

  setUserState(id: string, value: unknown): void {
    this.colyseus.send('set_user_state', { key: id, value })
  }

  getUserState(id: string): Promise<unknown> {
    return new Promise((resolve) => {
      const handler = (msg: unknown) => {
        const m = msg as any
        if (m.key === id) {
          this.events.off('state_response', handler)
          resolve(m.value)
        }
      }
      this.events.on('state_response', handler)
      this.colyseus.send('get_user_state', { key: id })
    })
  }

  recordAction(id: string, metadata?: Record<string, unknown>): void {
    this.colyseus.send('session_action', { action: id, metadata })
  }
}
