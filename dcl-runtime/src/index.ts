/**
 * Virvi generic runtime scene.
 *
 * One pre-built scene serves every wizard World. The server rewrites scene.json at deploy time
 * (parcels, base, and a `virvi` block with apiUrl/wssUrl); nothing else is scene-specific. The scene
 * itself is found through the location setup, like any other vlm-dcl scene, so no sceneId is passed.
 */
import { createVLM } from '@virvixr/dcl'
// @ts-ignore provided by the Decentraland runtime
import { getSceneInformation } from '~system/Runtime'

async function main() {
  try {
    const info = await getSceneInformation({})
    const virvi = JSON.parse(info.metadataJson || '{}').virvi ?? {}
    const { apiUrl, wssUrl } = virvi
    if (!apiUrl || !wssUrl) {
      console.error('Virvi runtime: scene.json is missing virvi.apiUrl / virvi.wssUrl, not connecting')
      return
    }
    await createVLM({ apiUrl, wssUrl })
  } catch (err) {
    console.error('Virvi runtime failed to initialize:', err)
  }
}

main()
