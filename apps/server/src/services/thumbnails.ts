import sharp from 'sharp'
import { createStorage } from '../storage/index.js'

/**
 * Generate a thumbnail for an uploaded asset.
 *
 * - For image files (png, jpg, webp, etc.) we resize to 256x256 cover crop.
 * - For GLB/GLTF 3D models server-side rendering would require headless GL
 *   (e.g. puppeteer + three.js). This is left as a future enhancement;
 *   callers receive `null` for non-image content types.
 */
export async function generateThumbnail(
  data: Buffer,
  contentType: string,
  assetId: string,
): Promise<string | null> {
  // Only generate thumbnails for image content types
  if (!contentType.startsWith('image/')) {
    // TODO: For model/gltf-binary and model/gltf+json, consider a WebGL-based
    // thumbnail renderer (e.g. headless Chromium + three.js snapshot).
    return null
  }

  const storage = createStorage()

  const thumbnail = await sharp(data)
    .resize(256, 256, { fit: 'cover' })
    .webp({ quality: 80 })
    .toBuffer()

  const key = `thumbnails/${assetId}.webp`
  return storage.upload(key, thumbnail, 'image/webp')
}
