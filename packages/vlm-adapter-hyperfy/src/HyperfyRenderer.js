/**
 * HyperfyRenderer — React component that reads the EntityStore and renders
 * Hyperfy JSX elements for each VLM entity.
 *
 * The HyperfyAdapter writes to EntityStore imperatively.
 * This component subscribes to changes and re-renders the scene graph.
 */

import React, { useState, useEffect } from 'react'
import { EntityStore } from './EntityStore.js'
import { VideoElement } from './elements/VideoElement.js'
import { ImageElement } from './elements/ImageElement.js'
import { ModelElement } from './elements/ModelElement.js'
import { SoundElement } from './elements/SoundElement.js'
import { getPointerProps } from './elements/ClickHandler.js'

export function HyperfyRenderer() {
  const [, forceUpdate] = useState(0)

  useEffect(() => {
    return EntityStore.subscribe(() => forceUpdate((n) => n + 1))
  }, [])

  const entities = EntityStore.getAllEntities()

  return (
    <>
      {entities.map((entity) => {
        if (!entity.transform) return null

        const { position, rotation, scale } = entity.transform
        const pos = [position.x, position.y, position.z]
        const rot = [rotation.x, rotation.y, rotation.z]
        const scl = [scale.x, scale.y, scale.z]

        const { onPointerDown, hint } = getPointerProps(entity)

        switch (entity.type) {
          case 'video':
            return (
              <app key={entity.id} position={pos} rotation={rot} scale={scl}>
                <VideoElement
                  entity={entity}
                  onPointerDown={onPointerDown}
                  hint={hint}
                />
              </app>
            )

          case 'image':
          case 'plane':
            return (
              <app key={entity.id} position={pos} rotation={rot} scale={scl}>
                <ImageElement
                  entity={entity}
                  onPointerDown={onPointerDown}
                  hint={hint}
                />
              </app>
            )

          case 'model':
            return (
              <app key={entity.id} position={pos} rotation={rot} scale={scl}>
                <ModelElement
                  entity={entity}
                  onPointerDown={onPointerDown}
                  hint={hint}
                />
              </app>
            )

          case 'audio':
            return (
              <app key={entity.id} position={pos} rotation={rot} scale={scl}>
                <SoundElement entity={entity} />
              </app>
            )

          default:
            return null
        }
      })}
    </>
  )
}
