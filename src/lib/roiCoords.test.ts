import { describe, it, expect } from 'vitest'
import {
  cssToNormalized,
  normalizedToCss,
  cssRectToNormalized,
  normalizedRectToCss,
  type VideoFitInfo,
} from './roiCoords.ts'

// helpers
const almostEq = (a: number, b: number, eps = 0.0001) => Math.abs(a - b) < eps

// --- cover: matching aspect ratios (1280x720 in 1280x720 container) ---
describe('cover – matching AR (no crop)', () => {
  const fit: VideoFitInfo = {
    containerW: 1280, containerH: 720,
    videoW: 1280, videoH: 720,
    objectFit: 'cover',
  }

  it('top-left corner maps to 0,0', () => {
    const [nx, ny] = cssToNormalized(0, 0, fit)
    expect(almostEq(nx, 0)).toBe(true)
    expect(almostEq(ny, 0)).toBe(true)
  })

  it('bottom-right corner maps to 1,1', () => {
    const [nx, ny] = cssToNormalized(1280, 720, fit)
    expect(almostEq(nx, 1)).toBe(true)
    expect(almostEq(ny, 1)).toBe(true)
  })

  it('centre maps to 0.5,0.5', () => {
    const [nx, ny] = cssToNormalized(640, 360, fit)
    expect(almostEq(nx, 0.5)).toBe(true)
    expect(almostEq(ny, 0.5)).toBe(true)
  })

  it('inverse round-trip', () => {
    const [cx, cy] = normalizedToCss(0.3, 0.7, fit)
    const [nx, ny] = cssToNormalized(cx, cy, fit)
    expect(almostEq(nx, 0.3)).toBe(true)
    expect(almostEq(ny, 0.7)).toBe(true)
  })
})

// --- cover: portrait video (720×1280) in 16:9 landscape container (1280x720) ---
// object-cover scales so width fills (1280px), height becomes 1280*(1280/720)≈2275px
// top/bottom are cropped: offset ≈ (2275-720)/2 ≈ 777px above top of container
describe('cover – portrait video in landscape container', () => {
  const fit: VideoFitInfo = {
    containerW: 1280, containerH: 720,
    videoW: 720, videoH: 1280,
    objectFit: 'cover',
  }

  it('container left edge maps to x=0 in video', () => {
    const [nx] = cssToNormalized(0, 360, fit)
    expect(almostEq(nx, 0)).toBe(true)
  })

  it('container right edge maps to x=1 in video', () => {
    const [nx] = cssToNormalized(1280, 360, fit)
    expect(almostEq(nx, 1)).toBe(true)
  })

  it('container top (y=0) maps to a y>0 in video (top is cropped)', () => {
    const [, ny] = cssToNormalized(640, 0, fit)
    expect(ny).toBeGreaterThan(0)
    expect(ny).toBeLessThan(0.5)
  })

  it('container vertical centre maps to video y=0.5', () => {
    const [, ny] = cssToNormalized(640, 360, fit)
    expect(almostEq(ny, 0.5)).toBe(true)
  })

  it('inverse round-trip', () => {
    const [cx, cy] = normalizedToCss(0.4, 0.6, fit)
    const [nx, ny] = cssToNormalized(cx, cy, fit)
    expect(almostEq(nx, 0.4)).toBe(true)
    expect(almostEq(ny, 0.6)).toBe(true)
  })
})

// --- contain: 16:9 video in square container ---
describe('contain – 16:9 video in square container', () => {
  const fit: VideoFitInfo = {
    containerW: 720, containerH: 720,
    videoW: 1280, videoH: 720,
    objectFit: 'contain',
  }
  // rendered rect: width=720, height=720*(720/1280)=405, centred → y offset=(720-405)/2=157.5

  it('top-left of rendered video rect maps to 0,0', () => {
    const [nx, ny] = cssToNormalized(0, 157.5, fit)
    expect(almostEq(nx, 0)).toBe(true)
    expect(almostEq(ny, 0)).toBe(true)
  })

  it('pixel above rendered area clamps to ny=0', () => {
    const [, ny] = cssToNormalized(360, 0, fit)
    expect(almostEq(ny, 0)).toBe(true)
  })

  it('centre of container maps to 0.5,0.5', () => {
    const [nx, ny] = cssToNormalized(360, 360, fit)
    expect(almostEq(nx, 0.5)).toBe(true)
    expect(almostEq(ny, 0.5)).toBe(true)
  })
})

// --- rect helpers round-trip ---
describe('rect helpers', () => {
  const fit: VideoFitInfo = {
    containerW: 1280, containerH: 720,
    videoW: 1280, videoH: 720,
    objectFit: 'cover',
  }

  it('cssRectToNormalized → normalizedRectToCss round-trip', () => {
    const css = { x: 100, y: 50, w: 400, h: 200 }
    const norm = cssRectToNormalized(css, fit)
    const back = normalizedRectToCss(norm, fit)
    expect(almostEq(back.x, css.x)).toBe(true)
    expect(almostEq(back.y, css.y)).toBe(true)
    expect(almostEq(back.w, css.w)).toBe(true)
    expect(almostEq(back.h, css.h)).toBe(true)
  })
})
