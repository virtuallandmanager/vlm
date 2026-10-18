import { defineRailway, preserve, project, service } from "railway/iac";

// Applied only by `railway config apply` (Railway doesn't read this file during deploys).
// It owns only vlm-server; Postgres and its volume stay managed in the dashboard.
// Every variable must be listed here (preserve() keeps the value set in Railway), or the next apply deletes it:
// after adding a variable in the dashboard, add it below, and always run `railway config plan` before applying.
export const partial = "vlm-server";

export default defineRailway(() => {
  const vlmServer = service("vlm-server", {
    start: "apps/server/entrypoint.sh",
    healthcheck: "/api/health",
    healthcheckTimeout: 120,
    replicas: 1,
    env: { AWS_ACCESS_KEY_ID: preserve(), AWS_SECRET_ACCESS_KEY: preserve(), CDN_URL: preserve(), CORS_ORIGINS: preserve(), DATABASE_URL: preserve(), HLS_BASE_URL: preserve(), JWT_SECRET: preserve(), LOCAL_STORAGE_PATH: preserve(), NEXT_PUBLIC_API_URL: preserve(), NEXT_PUBLIC_WSS_URL: preserve(), PUBLIC_URL: preserve(), RTMP_INGEST_URL: preserve(), S3_BUCKET: preserve(), S3_ENDPOINT: preserve(), S3_REGION: preserve(), STORAGE_PROVIDER: preserve(), STREAMING_WEBHOOK_KEY: preserve(), STRIPE_SECRET_KEY: preserve(), STRIPE_WEBHOOK_SECRET: preserve(), VLM_MODE: preserve(), WEB_APP_URL: preserve() },
  });
  return project("VLM", {
    resources: [vlmServer],
  });
});
