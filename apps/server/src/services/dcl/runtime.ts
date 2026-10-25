/**
 * The generic Virvi Decentraland runtime: one pre-built scene bundle deployed for every wizard World.
 *
 * Contract: the runtime reads `scene.json`'s `virvi.{apiUrl,wssUrl}` through
 * `getSceneInformation().metadataJson` and calls `createVLM({ apiUrl, wssUrl })` with no `sceneId`.
 * The scene is found through the location setup (created in Task 7), the same path every `vlm-dcl`
 * scene uses; that setup is also what grants in-world edit rights, so no separate scene-id file exists.
 * Models load from `models/vlm/<basename>.glb`, as `DclAdapter.resolveModelSrc` does.
 *
 * Built output is committed under apps/server/dcl-runtime/<version>/bin/index.js (rebuild with
 * `bash dcl-runtime/build.sh`). Resolved relative to this module, so it works from src/ and dist/services/dcl/.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const DCL_RUNTIME_VERSION = 1

const RUNTIME_ROOT = fileURLToPath(new URL('../../../dcl-runtime/', import.meta.url))

export async function runtimeFiles(version: number = DCL_RUNTIME_VERSION): Promise<Map<string, Uint8Array>> {
  if (!Number.isInteger(version) || version < 1) throw new Error(`Unknown Decentraland runtime version: ${version}`)
  let bytes: Buffer
  try {
    bytes = await readFile(`${RUNTIME_ROOT}${version}/bin/index.js`)
  } catch {
    throw new Error(`Unknown Decentraland runtime version: ${version}`)
  }
  return new Map([['bin/index.js', new Uint8Array(bytes)]])
}
