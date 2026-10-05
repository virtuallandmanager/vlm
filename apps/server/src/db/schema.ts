import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  primaryKey,
  pgEnum,
  customType,
  index,
  uniqueIndex,
  check,
  bigserial,
  real,
  smallint,
  date,
} from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'
import type { VenueRules } from 'vlm-shared'

// ── Enums ────────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum('user_role', ['admin', 'creator', 'viewer'])
export const authMethodTypeEnum = pgEnum('auth_method_type', ['email', 'wallet', 'oauth'])
export const collaboratorRoleEnum = pgEnum('collaborator_role', ['owner', 'editor', 'viewer'])
export const elementTypeEnum = pgEnum('element_type', [
  'image',
  'video',
  'nft',
  'sound',
  'widget',
  'custom',
  'model',
])

export const orgRoleEnum = pgEnum('org_role', ['owner', 'admin', 'member'])
export const inviteStatusEnum = pgEnum('invite_status', ['pending', 'accepted', 'declined', 'expired'])

// ── Organizations ───────────────────────────────────────────────────────────

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  billingOwnerId: uuid('billing_owner_id'), // set after users table exists via migration
  logoUrl: text('logo_url'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const organizationsRelations = relations(organizations, ({ one, many }) => ({
  members: many(orgMembers),
  scenes: many(scenes),
  mediaAssets: many(mediaAssets),
  events: many(events),
  giveaways: many(giveaways),
  subscriptions: many(subscriptions),
}))

// ── Organization Members ────────────────────────────────────────────────────

export const orgMembers = pgTable(
  'org_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: orgRoleEnum('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.userId] }),
  }),
)

export const orgMembersRelations = relations(orgMembers, ({ one }) => ({
  org: one(organizations, {
    fields: [orgMembers.orgId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [orgMembers.userId],
    references: [users.id],
  }),
}))

// ── Organization Invites ────────────────────────────────────────────────────

export const orgInvites = pgTable('org_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: orgRoleEnum('role').notNull().default('member'),
  invitedBy: uuid('invited_by')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  status: inviteStatusEnum('status').notNull().default('pending'),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const orgInvitesRelations = relations(orgInvites, ({ one }) => ({
  org: one(organizations, {
    fields: [orgInvites.orgId],
    references: [organizations.id],
  }),
  inviter: one(users, {
    fields: [orgInvites.invitedBy],
    references: [users.id],
  }),
}))

// ── Users ────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
  email: text('email'),
  role: userRoleEnum('role').notNull().default('creator'),
  activeOrgId: uuid('active_org_id'), // current org context (FK added via migration to avoid circular)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const usersRelations = relations(users, ({ one, many }) => ({
  authMethods: many(userAuthMethods),
  scenes: many(scenes),
  collaborations: many(sceneCollaborators),
  mediaAssets: many(mediaAssets),
  orgMemberships: many(orgMembers),
  activeOrg: one(organizations, {
    fields: [users.activeOrgId],
    references: [organizations.id],
  }),
}))

// ── User Auth Methods ────────────────────────────────────────────────────────

export const userAuthMethods = pgTable('user_auth_methods', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  type: authMethodTypeEnum('type').notNull(),
  identifier: text('identifier').notNull(),
  credentialHash: text('credential_hash'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const userAuthMethodsRelations = relations(userAuthMethods, ({ one }) => ({
  user: one(users, {
    fields: [userAuthMethods.userId],
    references: [users.id],
  }),
}))

// ── Scenes ───────────────────────────────────────────────────────────────────

export const scenes = pgTable('scenes', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  thumbnailUrl: text('thumbnail_url'),
  activePresetId: uuid('active_preset_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const scenesRelations = relations(scenes, ({ one, many }) => ({
  org: one(organizations, {
    fields: [scenes.orgId],
    references: [organizations.id],
  }),
  owner: one(users, {
    fields: [scenes.ownerId],
    references: [users.id],
  }),
  presets: many(scenePresets),
  collaborators: many(sceneCollaborators),
  state: many(sceneState),
}))

// ── Scene Presets ────────────────────────────────────────────────────────────

export const scenePresets = pgTable('scene_presets', {
  id: uuid('id').primaryKey().defaultRandom(),
  sceneId: uuid('scene_id')
    .notNull()
    .references(() => scenes.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  locale: text('locale'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const scenePresetsRelations = relations(scenePresets, ({ one, many }) => ({
  scene: one(scenes, {
    fields: [scenePresets.sceneId],
    references: [scenes.id],
  }),
  elements: many(sceneElements),
}))

// ── Scene Elements ───────────────────────────────────────────────────────────

export const sceneElements = pgTable('scene_elements', {
  id: uuid('id').primaryKey().defaultRandom(),
  presetId: uuid('preset_id')
    .notNull()
    .references(() => scenePresets.id, { onDelete: 'cascade' }),
  type: elementTypeEnum('type').notNull(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  customId: text('custom_id'),
  customRendering: boolean('custom_rendering').notNull().default(false),
  clickEvent: jsonb('click_event'),
  properties: jsonb('properties'),
  clonedFromId: uuid('cloned_from_id'), // set when copied into a booking preset
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const sceneElementsRelations = relations(sceneElements, ({ one, many }) => ({
  preset: one(scenePresets, {
    fields: [sceneElements.presetId],
    references: [scenePresets.id],
  }),
  instances: many(sceneElementInstances),
}))

// ── Scene Element Instances ──────────────────────────────────────────────────

export const sceneElementInstances = pgTable('scene_element_instances', {
  id: uuid('id').primaryKey().defaultRandom(),
  elementId: uuid('element_id')
    .notNull()
    .references(() => sceneElements.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  customId: text('custom_id'),
  customRendering: boolean('custom_rendering').notNull().default(false),
  position: jsonb('position'),
  rotation: jsonb('rotation'),
  scale: jsonb('scale'),
  clickEvent: jsonb('click_event'),
  parentInstanceId: uuid('parent_instance_id'),
  withCollisions: boolean('with_collisions').notNull().default(false),
  properties: jsonb('properties'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const sceneElementInstancesRelations = relations(sceneElementInstances, ({ one }) => ({
  element: one(sceneElements, {
    fields: [sceneElementInstances.elementId],
    references: [sceneElements.id],
  }),
  parentInstance: one(sceneElementInstances, {
    fields: [sceneElementInstances.parentInstanceId],
    references: [sceneElementInstances.id],
  }),
}))

// ── Scene Collaborators ──────────────────────────────────────────────────────

export const sceneCollaborators = pgTable(
  'scene_collaborators',
  {
    sceneId: uuid('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: collaboratorRoleEnum('role').notNull().default('viewer'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sceneId, table.userId] }),
  }),
)

export const sceneCollaboratorsRelations = relations(sceneCollaborators, ({ one }) => ({
  scene: one(scenes, {
    fields: [sceneCollaborators.sceneId],
    references: [scenes.id],
  }),
  user: one(users, {
    fields: [sceneCollaborators.userId],
    references: [users.id],
  }),
}))

// ── Scene State (key-value per user per scene) ───────────────────────────────

export const sceneState = pgTable(
  'scene_state',
  {
    sceneId: uuid('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sceneId, table.userId, table.key] }),
  }),
)

export const sceneStateRelations = relations(sceneState, ({ one }) => ({
  scene: one(scenes, {
    fields: [sceneState.sceneId],
    references: [scenes.id],
  }),
  user: one(users, {
    fields: [sceneState.userId],
    references: [users.id],
  }),
}))

// ── Analytics ────────────────────────────────────────────────────────────────

export const analyticsSceneKindEnum = pgEnum('analytics_scene_kind', ['parcels', 'world', 'preview'])
export const analyticsClaimStatusEnum = pgEnum('analytics_claim_status', ['active', 'lapsed'])

export const analyticsScenes = pgTable('analytics_scenes', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: analyticsSceneKindEnum('kind').notNull(),
  locationKey: text('location_key').notNull().unique(),
  realm: text('realm').notNull(),
  baseParcel: text('base_parcel'),
  parcels: text('parcels').array().notNull().default(sql`'{}'::text[]`),
  worldName: text('world_name'),
  activeEntityId: text('active_entity_id'),
  title: text('title'),
  salt: text('salt').notNull(), // 64 hex chars; never sent to clients
  claimedByUserId: uuid('claimed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  claimStatus: analyticsClaimStatusEnum('claim_status'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  lapsedAt: timestamp('lapsed_at', { withTimezone: true }),
  vlmSceneId: uuid('vlm_scene_id').references(() => scenes.id, { onDelete: 'set null' }),
  walletVisibility: boolean('wallet_visibility').notNull().default(false),
  isPreview: boolean('is_preview').notNull().default(false),
  verifiedSessionShare: real('verified_session_share').notNull().default(0),
  lastEntityCheckAt: timestamp('last_entity_check_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  vlmSceneIdx: index('analytics_scenes_vlm_scene_idx').on(t.vlmSceneId),
  claimerIdx: index('analytics_scenes_claimer_idx').on(t.claimedByUserId),
}))

export const analyticsSessions = pgTable('analytics_sessions', {
  id: uuid('id').primaryKey(), // client-generated session id
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  visitorHash: text('visitor_hash').notNull(),
  wallet: text('wallet'),
  displayName: text('display_name'),
  isGuest: boolean('is_guest').notNull().default(false),
  verified: boolean('verified').notNull().default(false),
  platform: text('platform'),
  device: text('device'),
  realm: text('realm'),
  country: text('country'),
  cameraMode: text('camera_mode'),
  isReturning: boolean('is_returning').notNull().default(false),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  durationSec: integer('duration_sec').notNull().default(0),
  eventCount: integer('event_count').notNull().default(0),
}, (t) => ({
  sceneStartIdx: index('analytics_sessions_scene_started_idx').on(t.sceneId, t.startedAt),
  sceneSeenIdx: index('analytics_sessions_scene_seen_idx').on(t.sceneId, t.lastSeenAt),
  sceneVisitorIdx: index('analytics_sessions_scene_visitor_idx').on(t.sceneId, t.visitorHash),
}))

export const analyticsEvents = pgTable('analytics_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull(),
  seq: integer('seq').notNull(),
  visitorHash: text('visitor_hash').notNull(),
  type: text('type').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  verified: boolean('verified').notNull().default(false),
  data: jsonb('data'),
}, (t) => ({
  sessionSeqUq: uniqueIndex('analytics_events_session_seq_uq').on(t.sessionId, t.seq),
  sceneTimeIdx: index('analytics_events_scene_time_idx').on(t.sceneId, t.occurredAt),
}))

export const analyticsPositions = pgTable('analytics_positions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull(),
  seq: integer('seq').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  x: real('x').notNull(),
  y: real('y').notNull(),
  z: real('z').notNull(),
  heading: smallint('heading').notNull().default(0),
  moving: boolean('moving').notNull().default(false),
}, (t) => ({
  sessionSeqUq: uniqueIndex('analytics_positions_session_seq_uq').on(t.sessionId, t.seq),
  sceneTimeIdx: index('analytics_positions_scene_time_idx').on(t.sceneId, t.occurredAt),
}))

export const analyticsDirtyHours = pgTable('analytics_dirty_hours', {
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  hour: timestamp('hour', { withTimezone: true }).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.sceneId, t.hour] }) }))

export const analyticsJobRuns = pgTable('analytics_job_runs', {
  name: text('name').primaryKey(),
  lastRunDay: date('last_run_day').notNull(),
})

export const analyticsRollupHourly = pgTable('analytics_rollup_hourly', {
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  hour: timestamp('hour', { withTimezone: true }).notNull(),
  sessions: integer('sessions').notNull().default(0),
  uniqueVisitors: integer('unique_visitors').notNull().default(0),
  newVisitors: integer('new_visitors').notNull().default(0),
  returningVisitors: integer('returning_visitors').notNull().default(0),
  verifiedSessions: integer('verified_sessions').notNull().default(0),
  peakConcurrency: integer('peak_concurrency').notNull().default(0),
  dwellAvgSec: integer('dwell_avg_sec').notNull().default(0),
  dwellP50Sec: integer('dwell_p50_sec').notNull().default(0),
  dwellP90Sec: integer('dwell_p90_sec').notNull().default(0),
  interactions: jsonb('interactions').notNull().default({}),
  video: jsonb('video').notNull().default({}),
  emotes: jsonb('emotes').notNull().default({}),
  countries: jsonb('countries').notNull().default({}),
  platforms: jsonb('platforms').notNull().default({}),
  cameraModes: jsonb('camera_modes').notNull().default({}),
}, (t) => ({ pk: primaryKey({ columns: [t.sceneId, t.hour] }) }))

export const analyticsHeatmapDaily = pgTable('analytics_heatmap_daily', {
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  day: date('day').notNull(),
  cellX: smallint('cell_x').notNull(),
  cellZ: smallint('cell_z').notNull(),
  dwellSec: integer('dwell_sec').notNull().default(0),
  visits: integer('visits').notNull().default(0),
}, (t) => ({ pk: primaryKey({ columns: [t.sceneId, t.day, t.cellX, t.cellZ] }) }))

export const analyticsCopresenceDaily = pgTable('analytics_copresence_daily', {
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  day: date('day').notNull(),
  visitorA: text('visitor_a').notNull(),
  visitorB: text('visitor_b').notNull(),
  overlapSec: integer('overlap_sec').notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.sceneId, t.day, t.visitorA, t.visitorB] }) }))

// ── Events ───────────────────────────────────────────────────────────────────

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  startTime: timestamp('start_time', { withTimezone: true }),
  endTime: timestamp('end_time', { withTimezone: true }),
  timezone: text('timezone').default('UTC'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const eventsRelations = relations(events, ({ one, many }) => ({
  owner: one(users, {
    fields: [events.ownerId],
    references: [users.id],
  }),
  sceneLinks: many(eventSceneLinks),
  giveawayLinks: many(eventGiveawayLinks),
}))

export const eventSceneLinks = pgTable('event_scene_links', {
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  sceneId: uuid('scene_id').notNull().references(() => scenes.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.eventId, table.sceneId] }),
}))

export const eventSceneLinksRelations = relations(eventSceneLinks, ({ one }) => ({
  event: one(events, {
    fields: [eventSceneLinks.eventId],
    references: [events.id],
  }),
  scene: one(scenes, {
    fields: [eventSceneLinks.sceneId],
    references: [scenes.id],
  }),
}))

// ── Giveaways ────────────────────────────────────────────────────────────────

export const giveaways = pgTable('giveaways', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  claimLimit: integer('claim_limit').default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const giveawaysRelations = relations(giveaways, ({ one, many }) => ({
  owner: one(users, {
    fields: [giveaways.ownerId],
    references: [users.id],
  }),
  items: many(giveawayItems),
  claims: many(giveawayClaims),
  eventLinks: many(eventGiveawayLinks),
}))

export const giveawayItems = pgTable('giveaway_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  giveawayId: uuid('giveaway_id').notNull().references(() => giveaways.id, { onDelete: 'cascade' }),
  name: text('name'),
  imageUrl: text('image_url'),
  contractAddress: text('contract_address'),
  tokenId: text('token_id'),
  metadata: jsonb('metadata'),
})

export const giveawayItemsRelations = relations(giveawayItems, ({ one }) => ({
  giveaway: one(giveaways, {
    fields: [giveawayItems.giveawayId],
    references: [giveaways.id],
  }),
}))

export const giveawayClaims = pgTable('giveaway_claims', {
  id: uuid('id').primaryKey().defaultRandom(),
  giveawayId: uuid('giveaway_id').notNull().references(() => giveaways.id),
  userId: text('user_id'),
  walletAddress: text('wallet_address'),
  itemId: uuid('item_id').references(() => giveawayItems.id),
  status: text('status').notNull().default('pending'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
})

export const giveawayClaimsRelations = relations(giveawayClaims, ({ one }) => ({
  giveaway: one(giveaways, {
    fields: [giveawayClaims.giveawayId],
    references: [giveaways.id],
  }),
  item: one(giveawayItems, {
    fields: [giveawayClaims.itemId],
    references: [giveawayItems.id],
  }),
}))

export const eventGiveawayLinks = pgTable('event_giveaway_links', {
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  giveawayId: uuid('giveaway_id').notNull().references(() => giveaways.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.eventId, table.giveawayId] }),
}))

export const eventGiveawayLinksRelations = relations(eventGiveawayLinks, ({ one }) => ({
  event: one(events, {
    fields: [eventGiveawayLinks.eventId],
    references: [events.id],
  }),
  giveaway: one(giveaways, {
    fields: [eventGiveawayLinks.giveawayId],
    references: [giveaways.id],
  }),
}))

// ── Platform Callbacks (HTTP push for non-WebSocket platforms) ──────────────

export const platformCallbacks = pgTable('platform_callbacks', {
  id: uuid('id').primaryKey().defaultRandom(),
  sceneId: uuid('scene_id')
    .notNull()
    .references(() => scenes.id, { onDelete: 'cascade' }),
  elementId: text('element_id'), // customId or SK — null for controller/scene-level
  elementType: text('element_type'), // 'video' | 'image' | 'controller' — null for scene-level
  platform: text('platform').notNull(), // 'secondlife', etc.
  mode: text('mode').notNull().default('element'), // 'element' | 'controller'
  callbackUrl: text('callback_url').notNull(),
  region: text('region'), // platform-specific location for debugging
  metadata: jsonb('metadata'),
  failureCount: integer('failure_count').notNull().default(0),
  lastRegistered: timestamp('last_registered', { withTimezone: true }).notNull().defaultNow(),
})

export const platformCallbacksRelations = relations(platformCallbacks, ({ one }) => ({
  scene: one(scenes, {
    fields: [platformCallbacks.sceneId],
    references: [scenes.id],
  }),
}))

// ── Media Assets ────────────────────────────────────────────────────────────

export const mediaAssets = pgTable('media_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  storageKey: text('storage_key').notNull(), // path in storage provider
  publicUrl: text('public_url'),
  folder: text('folder').default('/'),
  metadata: jsonb('metadata'), // dimensions, duration, etc.
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const mediaAssetsRelations = relations(mediaAssets, ({ one }) => ({
  owner: one(users, {
    fields: [mediaAssets.ownerId],
    references: [users.id],
  }),
}))

// ── 3D Asset Library ───────────────────────────────────────────────────────

export const assetLibraryItems = pgTable('asset_library_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  category: text('category'), // 'architecture', 'nature', 'furniture', 'effects', etc.
  tags: text('tags').array(), // ['modern', 'outdoor', 'low-poly']
  storageKey: text('storage_key').notNull(),
  cdnUrl: text('cdn_url'),
  thumbnailUrl: text('thumbnail_url'),
  fileSizeBytes: integer('file_size_bytes').notNull().default(0),
  triangleCount: integer('triangle_count'),
  textureCount: integer('texture_count'),
  materialCount: integer('material_count'),
  dimensions: jsonb('dimensions'), // { width, height, depth }
  license: text('license'), // 'cc0', 'cc-by', 'proprietary', etc.
  author: text('author'),
  isPublic: boolean('is_public').notNull().default(true),
  uploadedBy: uuid('uploaded_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const assetLibraryItemsRelations = relations(assetLibraryItems, ({ one }) => ({
  uploader: one(users, {
    fields: [assetLibraryItems.uploadedBy],
    references: [users.id],
  }),
}))

// ── Scene Deployments ──────────────────────────────────────────────────────

export const deploymentStatusEnum = pgEnum('deployment_status', [
  'pending',
  'building',
  'deploying',
  'deployed',
  'failed',
])

export const sceneDeployments = pgTable('scene_deployments', {
  id: uuid('id').primaryKey().defaultRandom(),
  sceneId: uuid('scene_id')
    .notNull()
    .references(() => scenes.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(), // 'decentraland' | 'hyperfy'
  status: deploymentStatusEnum('status').notNull().default('pending'),
  deploymentType: text('deployment_type').notNull(), // 'parcel' | 'world' | 'instance'
  target: jsonb('target').notNull(), // DCL: { parcels, contentServer } / Hyperfy: { instanceUrl, region }
  assetBundle: jsonb('asset_bundle'), // list of asset IDs + config included in deploy
  deployedBy: uuid('deployed_by').references(() => users.id),
  errorMessage: text('error_message'),
  catalystEntityId: text('catalyst_entity_id'), // DCL catalyst entity hash
  infrastructureId: text('infrastructure_id'), // Hyperfy: Docker container ID, Fly machine ID
  deployedAt: timestamp('deployed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const sceneDeploymentsRelations = relations(sceneDeployments, ({ one }) => ({
  scene: one(scenes, {
    fields: [sceneDeployments.sceneId],
    references: [scenes.id],
  }),
  deployer: one(users, {
    fields: [sceneDeployments.deployedBy],
    references: [users.id],
  }),
}))

export const deploymentWallets = pgTable('deployment_wallets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(), // 'decentraland'
  walletAddress: text('wallet_address').notNull(),
  encryptedPrivateKey: text('encrypted_private_key'), // AES-256-GCM encrypted
  label: text('label'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const deploymentWalletsRelations = relations(deploymentWallets, ({ one }) => ({
  user: one(users, {
    fields: [deploymentWallets.userId],
    references: [users.id],
  }),
}))

// ── Streaming Servers ──────────────────────────────────────────────────────

export const streamingServerTypeEnum = pgEnum('streaming_server_type', ['shared', 'dedicated'])
export const streamingServerStatusEnum = pgEnum('streaming_server_status', [
  'provisioning',
  'ready',
  'live',
  'offline',
  'error',
  'terminated',
])

export const streamingServers = pgTable('streaming_servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: streamingServerTypeEnum('type').notNull().default('shared'),
  status: streamingServerStatusEnum('status').notNull().default('provisioning'),
  rtmpUrl: text('rtmp_url'), // e.g. rtmp://ingest.vlm.gg/live
  streamKey: text('stream_key'), // unique key for this stream
  hlsPlaylistUrl: text('hls_playlist_url'), // e.g. https://cdn.vlm.gg/streams/{id}/playlist.m3u8
  region: text('region').default('us-east-1'),
  infrastructureId: text('infrastructure_id'), // ECS task ARN, Fly machine ID, etc.
  sceneId: uuid('scene_id').references(() => scenes.id), // optional: auto-link to a scene's video
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const streamingServersRelations = relations(streamingServers, ({ one, many }) => ({
  owner: one(users, {
    fields: [streamingServers.ownerId],
    references: [users.id],
  }),
  scene: one(scenes, {
    fields: [streamingServers.sceneId],
    references: [scenes.id],
  }),
  sessions: many(streamingSessions),
}))

// ── Streaming Sessions ─────────────────────────────────────────────────────

export const streamingSessions = pgTable('streaming_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id')
    .notNull()
    .references(() => streamingServers.id, { onDelete: 'cascade' }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  durationSeconds: integer('duration_seconds'),
  peakBitrate: integer('peak_bitrate'), // kbps
  peakViewers: integer('peak_viewers'),
  recorded: boolean('recorded').notNull().default(false),
  vodStorageKey: text('vod_storage_key'), // S3 key for recorded VOD
  vodUrl: text('vod_url'), // public URL after processing
})

export const streamingSessionsRelations = relations(streamingSessions, ({ one }) => ({
  server: one(streamingServers, {
    fields: [streamingSessions.serverId],
    references: [streamingServers.id],
  }),
}))

// ── Subscriptions (Stripe Billing) ─────────────────────────────────────────

export const subscriptionTierEnum = pgEnum('subscription_tier', [
  'free',
  'creator',
  'pro',
  'studio',
  'enterprise',
])

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'past_due',
  'canceled',
  'trialing',
  'unpaid',
  'incomplete',
])

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  stripePriceId: text('stripe_price_id'),
  tier: subscriptionTierEnum('tier').notNull().default('free'),
  status: subscriptionStatusEnum('status').notNull().default('active'),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, {
    fields: [subscriptions.userId],
    references: [users.id],
  }),
}))

// ── API Keys ────────────────────────────────────────────────────────────────

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(), // SHA-256 hash of the key
  keyPrefix: text('key_prefix').notNull(), // first 8 chars for identification (e.g., "vlm_k1_a")
  scopes: text('scopes').array(), // ['scenes:read', 'scenes:write', 'media:read', 'media:write']
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, {
    fields: [apiKeys.userId],
    references: [users.id],
  }),
  org: one(organizations, {
    fields: [apiKeys.orgId],
    references: [organizations.id],
  }),
}))

// ── Password Reset Tokens ───────────────────────────────────────────────────

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const passwordResetTokensRelations = relations(passwordResetTokens, ({ one }) => ({
  user: one(users, {
    fields: [passwordResetTokens.userId],
    references: [users.id],
  }),
}))

// ── Upload Tokens (Companion Upload Flow) ──────────────────────────────────

export const uploadTokens = pgTable('upload_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(), // short alphanumeric code (e.g. "abc123")
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  sceneId: uuid('scene_id').references(() => scenes.id, { onDelete: 'cascade' }),
  maxUploads: integer('max_uploads').notNull().default(10),
  uploadCount: integer('upload_count').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const uploadTokensRelations = relations(uploadTokens, ({ one }) => ({
  user: one(users, {
    fields: [uploadTokens.userId],
    references: [users.id],
  }),
  scene: one(scenes, {
    fields: [uploadTokens.sceneId],
    references: [scenes.id],
  }),
}))

// ── Venues, Bookings & Access Grants ─────────────────────────────────────────

const tstzrange = customType<{ data: string }>({
  dataType() {
    return 'tstzrange'
  },
})

export const venueKindEnum = pgEnum('venue_kind', ['permanent', 'popup'])
export const bookingStatusEnum = pgEnum('booking_status', ['pending', 'confirmed', 'live', 'ended', 'canceled'])
// Must match VENUE_SCOPES / VENUE_ROLES in vlm-shared (asserted in test/schema-venues.test.ts)
export const venueScopeEnum = pgEnum('venue_scope', [
  'screens',
  'playlist',
  'lights.cue',
  'lights.faders',
  'schedule',
  'presets',
  'audio',
  'moderation',
  'crew',
])
export const venueRoleEnum = pgEnum('venue_role', ['host', 'cohost', 'vj', 'lighting', 'performer', 'door'])

export const venues = pgTable('venues', {
  id: uuid('id').primaryKey().defaultRandom(),
  sceneId: uuid('scene_id')
    .notNull()
    .unique()
    .references(() => scenes.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  kind: venueKindEnum('kind').notNull().default('permanent'),
  defaultPresetId: uuid('default_preset_id')
    .notNull()
    .references(() => scenePresets.id),
  timezone: text('timezone').notNull().default('UTC'),
  rules: jsonb('rules').$type<VenueRules>().notNull(),
  rentableElementIds: uuid('rentable_element_ids').array().notNull().default(sql`'{}'::uuid[]`),
  isListed: boolean('is_listed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    venueId: uuid('venue_id')
      .notNull()
      .references(() => venues.id, { onDelete: 'cascade' }),
    renterUserId: uuid('renter_user_id').references(() => users.id, { onDelete: 'set null' }),
    renterWallet: text('renter_wallet'),
    title: text('title').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    status: bookingStatusEnum('status').notNull().default('pending'),
    bookingPresetId: uuid('booking_preset_id').references(() => scenePresets.id, { onDelete: 'set null' }),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
    paymentRef: jsonb('payment_ref'),
    blockedRange: tstzrange('blocked_range').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    venueIdx: index('bookings_venue_idx').on(t.venueId),
    statusIdx: index('bookings_status_idx').on(t.status),
    renterPresent: check('bookings_renter_present', sql`${t.renterUserId} IS NOT NULL OR ${t.renterWallet} IS NOT NULL`),
  }),
)

export const accessGrants = pgTable(
  'access_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    sceneId: uuid('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    walletAddress: text('wallet_address'), // lowercased
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    role: venueRoleEnum('role').notNull(),
    scopes: venueScopeEnum('scopes').array().notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    grantedByUserId: uuid('granted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bookingWallet: uniqueIndex('access_grants_booking_wallet_uq').on(t.bookingId, t.walletAddress),
    bookingUser: uniqueIndex('access_grants_booking_user_uq').on(t.bookingId, t.userId),
    sceneWallet: index('access_grants_scene_wallet_idx').on(t.sceneId, t.walletAddress),
    sceneUser: index('access_grants_scene_user_idx').on(t.sceneId, t.userId),
    subjectPresent: check('access_grants_subject_present', sql`${t.walletAddress} IS NOT NULL OR ${t.userId} IS NOT NULL`),
  }),
)

export const venuesRelations = relations(venues, ({ one, many }) => ({
  scene: one(scenes, { fields: [venues.sceneId], references: [scenes.id] }),
  bookings: many(bookings),
}))

export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  venue: one(venues, { fields: [bookings.venueId], references: [venues.id] }),
  grants: many(accessGrants),
}))

export const accessGrantsRelations = relations(accessGrants, ({ one }) => ({
  booking: one(bookings, { fields: [accessGrants.bookingId], references: [bookings.id] }),
}))
