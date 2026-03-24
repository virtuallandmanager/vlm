import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  integrations: [
    starlight({
      title: 'VLM Docs',
      description: 'Virtual Land Manager — Documentation',
      social: {
        github: 'https://github.com/virtuallandmanager/vlm',
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
          label: 'Self-Hosting',
          autogenerate: { directory: 'self-hosting' },
        },
      ],
    }),
  ],
})
