/**
 * VideoElement — Renders a video (or fallback image) using Hyperfy JSX.
 *
 * vlm-core's VideoManager handles live/playlist/image switching and sets
 * the `video.src` and `video.isImage` fields on the entity. This component
 * simply renders whatever source vlm-core provides.
 */

import React from 'react'

export function VideoElement({ entity, onPointerDown, hint }) {
  const { video, transform } = entity
  if (!video) return null

  const scale = transform?.scale
  const width = scale?.x || 2
  const height = scale?.y || 1.125

  // When the stream is offline and offType is IMAGE, vlm-core sets isImage
  if (video.isImage) {
    return (
      <image
        src={video.src}
        width={width}
        height={height}
        onPointerDown={onPointerDown}
        onPointerDownHint={hint}
      />
    )
  }

  return (
    <video
      src={video.src}
      width={width}
      height={height}
      autoplay
      loop={video.loop ?? false}
      volume={video.volume ?? 1}
      onPointerDown={onPointerDown}
      onPointerDownHint={hint}
    />
  )
}
