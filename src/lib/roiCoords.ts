import type { NormalizedRect } from './swingConfig.ts'

export interface VideoFitInfo {
  containerW: number
  containerH: number
  videoW: number
  videoH: number
  objectFit: 'cover' | 'contain'
}

export interface CssRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Compute the rendered video rect (in CSS pixels relative to container top-left)
 * accounting for object-fit cover or contain.
 */
function renderedRect(fit: VideoFitInfo): CssRect {
  const { containerW, containerH, videoW, videoH, objectFit } = fit
  if (videoW === 0 || videoH === 0) return { x: 0, y: 0, w: containerW, h: containerH }

  const containerAr = containerW / containerH
  const videoAr = videoW / videoH

  let rw: number, rh: number
  if (objectFit === 'cover') {
    // scale so the smaller dimension fills the container (may overflow the other)
    if (videoAr > containerAr) {
      rh = containerH
      rw = containerH * videoAr
    } else {
      rw = containerW
      rh = containerW / videoAr
    }
  } else {
    // contain: scale so the larger dimension fits inside
    if (videoAr > containerAr) {
      rw = containerW
      rh = containerW / videoAr
    } else {
      rh = containerH
      rw = containerH * videoAr
    }
  }

  // centred inside container
  return {
    x: (containerW - rw) / 2,
    y: (containerH - rh) / 2,
    w: rw,
    h: rh,
  }
}

/**
 * Map a CSS-pixel point (relative to the overlay/container) to
 * normalised video-frame coordinates [0..1]. Clamps to [0,1].
 */
export function cssToNormalized(
  cx: number,
  cy: number,
  fit: VideoFitInfo,
): [number, number] {
  const r = renderedRect(fit)
  const nx = Math.max(0, Math.min(1, (cx - r.x) / r.w))
  const ny = Math.max(0, Math.min(1, (cy - r.y) / r.h))
  return [nx, ny]
}

/**
 * Map normalised video-frame coordinates to CSS pixels in the container.
 */
export function normalizedToCss(
  nx: number,
  ny: number,
  fit: VideoFitInfo,
): [number, number] {
  const r = renderedRect(fit)
  return [r.x + nx * r.w, r.y + ny * r.h]
}

export function cssRectToNormalized(rect: CssRect, fit: VideoFitInfo): NormalizedRect {
  const [x1, y1] = cssToNormalized(rect.x, rect.y, fit)
  const [x2, y2] = cssToNormalized(rect.x + rect.w, rect.y + rect.h, fit)
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

export function normalizedRectToCss(roi: NormalizedRect, fit: VideoFitInfo): CssRect {
  const [x1, y1] = normalizedToCss(roi.x, roi.y, fit)
  const [x2, y2] = normalizedToCss(roi.x + roi.w, roi.y + roi.h, fit)
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}
