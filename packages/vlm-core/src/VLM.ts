import type { VLMPlatformAdapter, VLMInitConfig, VLMStorage as VLMStorageType, HUDRenderer, BudgetLimits } from 'vlm-shared'
import { VLMHttpClient, ColyseusManager } from 'vlm-client'
import { SceneManager } from './SceneManager'
import { VLMStorageImpl } from './storage'
import { EventBus } from './events/EventBus'

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

export class VLM {
  private adapter: VLMPlatformAdapter
  private http: VLMHttpClient
  private colyseus: ColyseusManager
  private sceneManager: SceneManager
  private events: EventBus
  private userMessageHandlers: Map<string, (data: unknown) => void> = new Map()
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

  async init(config: VLMInitConfig): Promise<VLMStorageType> {
    const env = config.env || 'prod'
    const apiUrl = API_URLS[env] || API_URLS.prod
    const wssUrl = WSS_URLS[env] || WSS_URLS.prod

    this.http = new VLMHttpClient(apiUrl)

    // 1. Get platform user + scene info from adapter
    const [platformUser, sceneInfo, environment] = await Promise.all([
      this.adapter.getPlatformUser(),
      this.adapter.getSceneInfo(),
      this.adapter.getEnvironment(),
    ])

    const sceneId = config.sceneId || sceneInfo.sceneId
    if (!sceneId) {
      throw new Error('No sceneId provided in config or scene metadata')
    }

    // 2. Authenticate with server
    const authProof = await this.adapter.getAuthProof()
    const authResponse = await this.http.authenticateWithPlatform(authProof, {
      sceneId,
      user: platformUser as unknown as Record<string, unknown>,
      world: this.adapter.capabilities.platformName,
      location: sceneInfo as unknown as Record<string, unknown>,
      environment: environment as unknown as Record<string, unknown>,
    })

    // 3. Join Colyseus room
    this.colyseus.connect(wssUrl)

    // 4. Register message handlers BEFORE joining (ColyseusManager queues them)
    this.registerMessageHandlers()

    // 5. Join room and wait for init
    return new Promise<VLMStorageType>(async (resolve, reject) => {
      try {
        // Listen for the init message
        this.events.on('scene_initialized', () => {
          resolve(this.storage)
        })

        await this.colyseus.joinSceneRoom(sceneId, {
          sessionToken: authResponse.accessToken,
          clientType: 'analytics',
          user: {
            id: authResponse.user.id,
            displayName: authResponse.user.displayName || platformUser.displayName,
            connectedWallet: platformUser.walletAddress,
          },
        })

        // Send session_start
        this.colyseus.send('session_start', {
          sessionToken: authResponse.accessToken,
          sceneId,
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  private registerMessageHandlers(): void {
    // Scene init + updates
    this.colyseus.onMessage('scene_preset_update', (message: unknown) => {
      this.sceneManager.handlePresetUpdate(message as any)
      if ((message as any).action === 'init') {
        this.events.emit('scene_initialized')
      }
    })

    // Preset switch
    this.colyseus.onMessage('scene_change_preset', (message: unknown) => {
      this.sceneManager.handlePresetChange(message as any)
    })

    // Video status (live/offline)
    this.colyseus.onMessage('scene_video_status', (message: unknown) => {
      this.sceneManager.handleVideoStatus(message as any)
    })

    // Session started acknowledgment
    this.colyseus.onMessage('session_started', (_message: unknown) => {
      // Store session data if needed
    })

    // User messages (custom messaging between players)
    this.colyseus.onMessage('user_message', (message: unknown) => {
      const msg = message as any
      if (msg?.messageId && this.userMessageHandlers.has(msg.messageId)) {
        this.userMessageHandlers.get(msg.messageId)!(msg.data)
      }
    })

    // User state responses
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
    this.colyseus.send('session_end', {})
    this.colyseus.leaveRoom()
  }

  /**
   * Initialize the in-world management HUD.
   *
   * Call after init() succeeds. Only works when:
   * 1. The platform supports screen-space or spatial UI
   * 2. A HUDRenderer is provided (platform-specific)
   * 3. vlm-hud package is available
   *
   * @param renderer Platform-specific HUD renderer implementation
   * @param budgetLimits Platform-specific asset budget limits
   */
  async initHUD(renderer: HUDRenderer, budgetLimits?: BudgetLimits): Promise<void> {
    if (!this.adapter.capabilities.screenSpaceUI && !this.adapter.capabilities.spatialUI) {
      return
    }

    try {
      const { HUDManager } = await import('vlm-hud')
      const limits: BudgetLimits = budgetLimits || {
        maxFileSizeBytes: 50 * 1024 * 1024, // 50 MB default
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

  setState(id: string, value: unknown): void {
    this.colyseus.send('set_user_state', { key: id, value })
  }

  getState(id: string): Promise<unknown> {
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
