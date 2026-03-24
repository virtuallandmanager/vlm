/**
 * ModelElement — Renders a glTF/GLB 3D model using Hyperfy JSX.
 */

import React from 'react'

export function ModelElement({ entity, onPointerDown, hint }) {
  const { model } = entity
  if (!model?.src) return null

  return (
    <model
      src={model.src}
      onPointerDown={onPointerDown}
      onPointerDownHint={hint}
    />
  )
}
