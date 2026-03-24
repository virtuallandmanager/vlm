/**
 * Server configuration — driven by VLM_MODE with per-variable overrides.
 *
 * Modes:
 *   single   — Self-hosted, one server, in-memory Colyseus presence
 *   scalable — Self-hosted, multiple servers + Redis presence
 *   cloud    — Hosted vlm.gg SaaS, multi-tenant, billing enabled
 */

export type VLMMode = 'single' | 'scalable' | 'cloud'

function env(key: string): string | undefined {
  return process.env[key]
}

const mode: VLMMode = (env('VLM_MODE') as VLMMode) || 'single'

export const config = {
  mode,

  // ── Server ──────────────────────────────────────────────────────────────
  port: parseInt(env('PORT') || '3010'),
  publicUrl: env('PUBLIC_URL') || 'http://localhost:3010',
  logLevel: env('LOG_LEVEL') || (env('NODE_ENV') === 'production' ? 'info' : 'debug'),

  // ── Database ────────────────────────────────────────────────────────────
  databaseUrl: env('DATABASE_URL')!,

  // ── Auth ─────────────────────────────────────────────────────────────────
  jwtSecret: env('JWT_SECRET') || 'dev-secret-change-me',
  jwtAccessExpiry: env('JWT_ACCESS_EXPIRY') || '15m',
  jwtRefreshExpiry: env('JWT_REFRESH_EXPIRY') || '7d',

  // ── Colyseus Presence ───────────────────────────────────────────────────
  // single: in-memory (no Redis needed)
  // scalable/cloud: Redis required for cross-server room routing
  useRedisPresence: env('REDIS_URL')
    ? true
    : mode !== 'single',
  redisUrl: env('REDIS_URL'),

  // ── Billing & Feature Gating ────────────────────────────────────────────
  billingEnabled: env('STRIPE_SECRET_KEY')
    ? true
    : mode === 'cloud',
  stripeSecretKey: env('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: env('STRIPE_WEBHOOK_SECRET'),

  // All features unlocked when billing is disabled (self-hosted gets everything)
  allFeaturesUnlocked: !env('STRIPE_SECRET_KEY') && mode !== 'cloud',

  // ── Multi-tenancy ───────────────────────────────────────────────────────
  multiTenant: env('MULTI_TENANT')
    ? env('MULTI_TENANT') === 'true'
    : mode === 'cloud',

  // ── Storage ─────────────────────────────────────────────────────────────
  storageProvider: env('STORAGE_PROVIDER')
    || (mode === 'cloud' ? 's3' : 'local'),
  cdnUrl: env('CDN_URL') || null,

  // Supabase (single mode default external storage)
  supabaseUrl: env('SUPABASE_URL'),
  supabaseAnonKey: env('SUPABASE_ANON_KEY'),
  supabaseServiceKey: env('SUPABASE_SERVICE_KEY'),

  // S3 / R2
  s3Bucket: env('S3_BUCKET'),
  s3Region: env('S3_REGION'),
  s3Endpoint: env('S3_ENDPOINT'), // For R2 or MinIO

  // Local filesystem
  localStoragePath: env('LOCAL_STORAGE_PATH') || './uploads',

  // ── Streaming ───────────────────────────────────────────────────────────
  streamingEnabled: env('ENABLE_STREAMING') === 'true' || mode === 'cloud',

  // ── Metrics ─────────────────────────────────────────────────────────────
  metricsEnabled: env('ENABLE_METRICS') === 'true' || mode !== 'single',

  // ── Auto-Promote First User ─────────────────────────────────────────────
  // In single/scalable mode, the first signup automatically becomes admin
  autoPromoteFirstUser: mode !== 'cloud',

  // ── Limits ──────────────────────────────────────────────────────────────
  maxRoomsPerServer: parseInt(env('MAX_ROOMS') || (mode === 'single' ? '50' : '500')),

  // ── Dashboard ───────────────────────────────────────────────────────────
  dashboardDir: env('DASHBOARD_DIR') || './dashboard',
} as const
