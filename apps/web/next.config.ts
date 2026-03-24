import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Static export — embedded in the server container as the dashboard SPA.
  // All data fetching is client-side so no SSR needed.
  output: 'export',
  trailingSlash: true,
}

export default nextConfig
