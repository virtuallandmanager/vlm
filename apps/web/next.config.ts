import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Use standalone output for production (embeddable in server container)
  // Dynamic routes like /scenes/[sceneId] require server-side rendering
  output: 'standalone',
  trailingSlash: true,
}

export default nextConfig
