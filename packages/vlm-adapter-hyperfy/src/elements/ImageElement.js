/**
 * ImageElement — Renders an image plane using Hyperfy JSX.
 *
 * Used for both dedicated image elements and plain plane entities.
 * Reads texture source from the entity's material data.
 */

import React from 'react'

export function ImageElement({ entity, onPointerDown, hint }) {
  const { material, transform } = entity
  if (!material?.textureSrc) return null

  const scale = transform?.scale
  const width = scale?.x || 2
  const height = scale?.y || 2

  return (
    <image
      src={material.textureSrc}
      width={width}
      height={height}
      opacity={material.isTransparent ? (material.albedoColor?.a ?? 1) : 1}
      emissive={material.emission ?? 0}
      onPointerDown={onPointerDown}
      onPointerDownHint={hint}
    />
  )
}
