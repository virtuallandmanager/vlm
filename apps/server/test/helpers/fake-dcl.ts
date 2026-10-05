import { DirectoryUnavailableError, type ActiveScene, type DclDirectory, type ParcelRights } from '../../src/analytics/dcl-directory.js'

export class FakeDclDirectory implements DclDirectory {
  scenes = new Map<string, ActiveScene>() // every parcel → its active scene
  deployers = new Map<string, string>()
  worlds = new Map<string, { sceneUrns: string[]; title?: string }>()
  rights = new Map<string, ParcelRights>()
  worldOwners = new Map<string, string>()
  down = false
  calls = 0

  private hit() {
    this.calls++
    if (this.down) throw new DirectoryUnavailableError('fake directory down')
  }

  /** Register a scene across its parcels. */
  addScene(scene: ActiveScene, deployer?: string) {
    for (const p of scene.parcels) {
      this.scenes.set(p, scene)
      if (deployer) this.deployers.set(p, deployer.toLowerCase())
    }
  }

  async getActiveSceneAt(parcel: string) { this.hit(); return this.scenes.get(parcel) ?? null }
  async getActiveDeployer(parcel: string) { this.hit(); return this.deployers.get(parcel) ?? null }
  async getWorldScene(name: string) { this.hit(); return this.worlds.get(name.toLowerCase()) ?? null }
  async getParcelRights(parcel: string) { this.hit(); return this.rights.get(parcel) ?? null }
  async getWorldOwner(name: string) { this.hit(); return this.worldOwners.get(name.toLowerCase()) ?? null }
}
