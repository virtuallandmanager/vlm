import type { VLMPlatformAdapter, EntityHandle, TransformData, Vec3 } from 'vlm-shared'

/** What every manager's instance record has in common for in-place transform editing. */
export interface TransformableInstance {
  sk: string
  entity: EntityHandle
  configSk: string
  position: Vec3
  rotation: Vec3
  scale: Vec3
}

export interface ListedInstance {
  sk: string
  name: string
  entity: EntityHandle
  transform: TransformData
}

const stored = (i: TransformableInstance): TransformData => ({ position: i.position, rotation: i.rotation, scale: i.scale })

export function listTransformable(
  instances: Map<string, TransformableInstance>,
  configs: Map<string, { name?: string }>,
): ListedInstance[] {
  return [...instances.values()].map((i) => ({
    sk: i.sk,
    name: configs.get(i.configSk)?.name || '',
    entity: i.entity,
    transform: stored(i),
  }))
}

/** Move the live entity only; stored instance data is untouched. Unknown sk is a no-op. */
export function previewOn(adapter: VLMPlatformAdapter, instances: Map<string, TransformableInstance>, sk: string, t: TransformData): void {
  const i = instances.get(sk)
  if (i) adapter.setTransform(i.entity, t)
}

/** Re-apply the stored transform to the live entity. Unknown sk is a no-op. */
export function restoreOn(adapter: VLMPlatformAdapter, instances: Map<string, TransformableInstance>, sk: string): void {
  const i = instances.get(sk)
  if (i) adapter.setTransform(i.entity, stored(i))
}
