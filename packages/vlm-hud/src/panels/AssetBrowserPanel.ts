/**
 * AssetBrowserPanel — Browse/search the 3D asset library, place assets in scene.
 *
 * Fetches assets from VLM API, renders thumbnail grid via HUDRenderer,
 * and tracks budget usage against platform limits.
 */

import type {
  HUDRenderer,
  AssetThumbnail,
  BudgetUsage,
  BudgetLimits,
} from 'vlm-shared'
import { HUDPanelType } from 'vlm-shared'
import type { VLMHttpClient } from 'vlm-client'

export class AssetBrowserPanel {
  private renderer: HUDRenderer
  private http: VLMHttpClient
  private assets: AssetThumbnail[] = []
  private usage: BudgetUsage = {
    fileSizeBytes: 0,
    triangleCount: 0,
    textureCount: 0,
    materialCount: 0,
    entityCount: 0,
  }
  private limits: BudgetLimits

  constructor(renderer: HUDRenderer, http: VLMHttpClient, limits: BudgetLimits) {
    this.renderer = renderer
    this.http = http
    this.limits = limits
  }

  /** Load and display the asset catalog. */
  async open(filters?: { q?: string; category?: string; tag?: string }): Promise<void> {
    try {
      const params: string[] = []
      if (filters?.q) params.push(`q=${encodeURIComponent(filters.q)}`)
      if (filters?.category) params.push(`category=${encodeURIComponent(filters.category)}`)
      if (filters?.tag) params.push(`tag=${encodeURIComponent(filters.tag)}`)
      const qs = params.length > 0 ? `?${params.join('&')}` : ''

      // Use the http client's generic fetch — asset routes added in Phase 10
      const result = await (this.http as any)._fetch(`/api/assets${qs}`) as any
      this.assets = (result?.assets || []).map((a: any) => ({
        id: a.id,
        name: a.name,
        thumbnailUrl: a.thumbnailUrl,
        cdnUrl: a.cdnUrl,
        category: a.category,
        fileSizeBytes: a.fileSizeBytes,
        triangleCount: a.triangleCount,
        tier: a.tier || null,
      }))

      this.renderer.showPanel(HUDPanelType.ASSET_BROWSER, { visible: true })
      this.renderer.renderAssetGrid(this.assets)
      this.renderer.renderBudgetMeter(this.usage, this.limits)
    } catch (err) {
      console.error('[HUD:AssetBrowser] Failed to load assets:', err)
    }
  }

  /** Search assets by query string. */
  async search(query: string): Promise<void> {
    await this.open({ q: query })
  }

  /** Filter assets by category. */
  async filterByCategory(category: string): Promise<void> {
    await this.open({ category })
  }

  /**
   * Request a companion upload token.
   * Returns a short URL and code that can be displayed as a QR code or short link.
   * The operator scans the QR on their phone to upload assets without leaving the world.
   */
  async requestUploadToken(sceneId?: string): Promise<{
    code: string
    uploadUrl: string
    expiresAt: string
  } | null> {
    try {
      const result = await (this.http as any)._fetch('/api/upload-tokens', {
        method: 'POST',
        body: JSON.stringify({
          sceneId,
          maxUploads: 10,
          expiresInMinutes: 30,
        }),
      }) as any
      return result?.token || null
    } catch {
      return null
    }
  }

  /** Update budget usage (called when elements change). */
  updateUsage(usage: Partial<BudgetUsage>): void {
    Object.assign(this.usage, usage)
    this.renderer.renderBudgetMeter(this.usage, this.limits)
  }

  /** Check if adding an asset would exceed platform limits. */
  wouldExceedBudget(asset: AssetThumbnail): boolean {
    return (
      (this.usage.fileSizeBytes + asset.fileSizeBytes) > this.limits.maxFileSizeBytes ||
      (asset.triangleCount !== null &&
        (this.usage.triangleCount + asset.triangleCount) > this.limits.maxTriangleCount)
    )
  }

  close(): void {
    this.renderer.hidePanel(HUDPanelType.ASSET_BROWSER)
  }
}
