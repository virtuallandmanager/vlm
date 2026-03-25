/**
 * VLM V2 — Decentraland Test Scene
 *
 * This scene tests the full VLM V2 pipeline:
 * 1. DclAdapter implements VLMPlatformAdapter
 * 2. vlm-core connects to the VLM server via Colyseus
 * 3. Server sends scene data (video element with instance)
 * 4. vlm-core calls DclAdapter to create entities, set transforms, play video
 * 5. A video screen appears in the Decentraland preview
 *
 * To test:
 * 1. Start the VLM server (apps/server with DATABASE_URL + JWT_SECRET)
 * 2. Create a scene and video element via the API
 * 3. Set the sceneId in scene.json
 * 4. Run: npx sdk-commands start
 */
import { createVLM } from 'vlm-smart-item-dcl'


async function main() {
  console.log('VLM V2 Test Scene starting...')

  try {

  await createVLM({
    sceneId: '3cb5c185-5475-4309-8ebd-43d568c62e0f',
    apiUrl: 'https://vlm-production.up.railway.app',
    wssUrl: 'wss://vlm-production.up.railway.app',
  })
    console.log('VLM V2 initialized!')

  } catch (err) {
    console.error('VLM V2 failed to initialize:', err)
  }
}

main()
