import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Static export for production — embedded in the server container as the dashboard SPA.
  // Disabled in dev so dynamic routes work without generateStaticParams constraints.
  output: process.env.NODE_ENV === 'production' ? 'export' : undefined,
  trailingSlash: true,
}

export default nextConfig
