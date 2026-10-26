import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  integrations: [
    starlight({
      title: 'Virvi Docs',
      description: 'Virvi documentation',
      // The navy wordmark on the light theme, the white one on the dark theme.
      logo: { light: './src/assets/virvi-logo-dark.svg', dark: './src/assets/virvi-logo-light.svg', alt: 'Virvi', replacesTitle: true },
      favicon: '/favicon.svg',
      social: {
        github: 'https://github.com/virvi-xr/virvi',
      },
      sidebar: [
        {
          label: 'Getting Started',
          autogenerate: { directory: 'getting-started' },
        },
        {
          label: 'Dashboard',
          autogenerate: { directory: 'dashboard' },
        },
        {
          label: 'SDK',
          autogenerate: { directory: 'sdk' },
        },
        {
          label: 'Custom Features',
          autogenerate: { directory: 'custom-features' },
        },
        {
          label: 'API',
          autogenerate: { directory: 'api' },
        },
        {
          label: 'Security',
          autogenerate: { directory: 'security' },
        },
        {
          label: 'Self-Hosting',
          autogenerate: { directory: 'self-hosting' },
        },
        { label: 'Privacy', link: '/privacy/' },
      ],
    }),
  ],
})
