/**
 * SoundElement — Renders a spatial or global audio source using Hyperfy JSX.
 */

import React from 'react'

export function SoundElement({ entity }) {
  const { audio } = entity
  if (!audio?.src) return null

  return (
    <audio
      src={audio.src}
      autoplay={audio.playing ?? false}
      loop={audio.loop ?? false}
      volume={audio.volume ?? 1}
      spatial={!audio.global}
    />
  )
}
