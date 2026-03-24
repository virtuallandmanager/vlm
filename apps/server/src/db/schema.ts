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
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

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
])

// ── Users ────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
  email: text('email'),
  role: userRoleEnum('role').notNull().default('creator'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const usersRelations = relations(users, ({ many }) => ({
  authMethods: many(userAuthMethods),
  scenes: many(scenes),
  collaborations: many(sceneCollaborators),
  mediaAssets: many(mediaAssets),
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

export const analyticsSessions = pgTable('analytics_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  sceneId: uuid('scene_id').references(() => scenes.id),
  userId: text('user_id'),
  walletAddress: text('wallet_address'),
  displayName: text('display_name'),
  role: integer('role').default(0),
  platform: text('platform'), // 'decentraland', 'hyperfy', etc.
  device: jsonb('device'),
  location: jsonb('location'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
})

export const analyticsSessionsRelations = relations(analyticsSessions, ({ one, many }) => ({
  scene: one(scenes, {
    fields: [analyticsSessions.sceneId],
    references: [scenes.id],
  }),
  actions: many(analyticsActions),
}))

export const analyticsActions = pgTable('analytics_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').references(() => analyticsSessions.id, { onDelete: 'cascade' }),
  sceneId: uuid('scene_id').references(() => scenes.id),
  name: text('name').notNull(),
  metadata: jsonb('metadata'),
  pathPoint: jsonb('path_point'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const analyticsActionsRelations = relations(analyticsActions, ({ one }) => ({
  session: one(analyticsSessions, {
    fields: [analyticsActions.sessionId],
    references: [analyticsSessions.id],
  }),
  scene: one(scenes, {
    fields: [analyticsActions.sceneId],
    references: [scenes.id],
  }),
}))

// ── Events ───────────────────────────────────────────────────────────────────

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
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
