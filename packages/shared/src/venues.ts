export const VENUE_SCOPES = [
  'screens',
  'playlist',
  'lights.cue',
  'lights.faders',
  'schedule',
  'presets',
  'audio',
  'moderation',
  'crew',
] as const
export type VenueScope = (typeof VENUE_SCOPES)[number]

export const VENUE_ROLES = ['host', 'cohost', 'vj', 'lighting', 'performer', 'door'] as const
export type VenueRole = (typeof VENUE_ROLES)[number]

export const VENUE_ROLE_SCOPES: Record<VenueRole, readonly VenueScope[]> = {
  host: VENUE_SCOPES,
  cohost: VENUE_SCOPES,
  vj: ['screens', 'playlist', 'schedule'],
  lighting: ['lights.cue', 'lights.faders', 'schedule'],
  performer: ['lights.cue'],
  door: ['moderation'],
}

export interface VenueRules {
  minHours: number
  maxHours: number
  setupLeadMinutes: number
  graceMinutes: number
  bufferMinutes: number
}

export const DEFAULT_VENUE_RULES: VenueRules = {
  minHours: 1,
  maxHours: 12,
  setupLeadMinutes: 60,
  graceMinutes: 15,
  bufferMinutes: 30,
}

export type BookingWindow = 'setup' | 'live'

/** Server → client on join and whenever the client's venue access changes. */
export interface VenueAccessMessage {
  bookingId: string | null
  role: VenueRole | null
  scopes: VenueScope[]
  window: BookingWindow | null
  validUntil: string | null
}

/** Server → client when the client loses venue access. */
export interface AccessRevokedMessage {
  bookingId: string | null
  reason: 'expired' | 'revoked' | 'canceled'
}

/** Server → client on join. */
export interface AuthStatusMessage {
  authenticated: boolean
}

export function isVenueScope(s: unknown): s is VenueScope {
  return typeof s === 'string' && (VENUE_SCOPES as readonly string[]).includes(s)
}

export function isVenueRole(s: unknown): s is VenueRole {
  return typeof s === 'string' && (VENUE_ROLES as readonly string[]).includes(s)
}
