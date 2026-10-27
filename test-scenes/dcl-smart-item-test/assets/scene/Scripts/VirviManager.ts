import { Entity } from '@dcl/sdk/ecs'
import { startVirviManager, VirviSmartItem } from '@virvixr/dcl'

/**
 * Connects this scene to Virvi.
 * Leave Scene ID blank to set the scene up from the in-world HUD.
 */
export class VirviManager {
  private item: VirviSmartItem | null = null

  constructor(
    public src: string,
    public entity: Entity,
    public sceneId: string = '',
    public env: string = 'prod',
    public serverUrl: string = '',
    public enableHud: boolean = true,
    public enableAnalytics: boolean = true,
    public showBeacon: boolean = false,
  ) {}

  start() {
    this.item = startVirviManager(this.entity, {
      sceneId: this.sceneId,
      env: this.env === 'dev' || this.env === 'staging' ? this.env : 'prod',
      serverUrl: this.serverUrl,
      enableHud: this.enableHud,
      enableAnalytics: this.enableAnalytics,
      showBeacon: this.showBeacon,
    })
  }
}
