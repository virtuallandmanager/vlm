/**
 * The HUD launcher's Virvi symbol: a white V image plus a live status dot.
 *
 * The image ships inside each scene (no CDN): `vlm-dcl sync` / `vlm-dcl install` copy it from the
 * vlm-dcl package (assets/hud-v.png, made by assets/make-hud-v.py) to this scene-relative path, and the
 * generic World runtime deploys it with its bundle. Keep the path in step with packages/dcl/bin/sync.mjs.
 */
export const HUD_ICON_SRC = 'images/virvi/hud-v.png'

/** The symbol's frame (viewBox 0 0 1254 1254); the PNG is the whole frame, so the dot overlays at frame-relative coordinates. */
const FRAME = 1254
const DOT = { cx: 627, cy: 373, r: 132 }

/** Where the status dot sits inside an icon of `size` design pixels. */
export function hudIconDot(size: number): { left: number; top: number; diameter: number } {
  const k = size / FRAME
  return { left: (DOT.cx - DOT.r) * k, top: (DOT.cy - DOT.r) * k, diameter: DOT.r * 2 * k }
}
