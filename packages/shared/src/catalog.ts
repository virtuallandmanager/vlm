// Open-source model catalog: the fixed vocabularies catalog models are tagged with, and the pack shape the API returns.

export const CATALOG_STYLES = [
  'Cyberpunk', 'Sci-Fi', 'Fantasy', 'Western', 'Steampunk', 'Pirates', 'Asian', 'Modern', 'Cozy', 'Minimalist',
  'Industrial', 'Nature', 'Voxel', 'Halloween', 'Classic',
] as const
/** What the object is. A model that can't be placed is 'Other'. */
export const CATALOG_CATEGORIES = [
  'Building', 'Structure', 'Furniture', 'Lighting', 'Decor', 'Plants & Nature', 'Food & Drink', 'Tech & Music',
  'Signage', 'Vehicles', 'Characters & Animals', 'Effects', 'Other',
] as const
/** Where the object fits; a model can fit many. */
export const CATALOG_VENUES = [
  'cafe', 'club', 'gallery', 'shop', 'office', 'home', 'outdoor', 'stage', 'beach', 'gym', 'restaurant', 'bar',
  'museum', 'park',
] as const

export type CatalogStyle = (typeof CATALOG_STYLES)[number]
export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number]
export type CatalogVenue = (typeof CATALOG_VENUES)[number]
export type CatalogSource = 'dhingia' | 'last-slice' | 'decentraland'
export type CatalogLicense = 'mit' | 'cc-by-nc-3.0' | 'unstated'

export interface CatalogPack {
  id: string
  name: string
  source: CatalogSource
  license: CatalogLicense
  attribution: string
  sourceUrl: string
  enabled: boolean
  modelCount: number
}
