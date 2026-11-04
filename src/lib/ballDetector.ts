import type { NormalizedRect } from './swingConfig.ts'

export interface BallPosition {
  nx: number      // normalized full-frame x [0..1]
  ny: number      // normalized full-frame y [0..1]
  radius: number  // normalized radius (full-frame units)
}

export interface BallDetectorConfig {
  // Luma units above the ROI mean required to count as "bright".
  // Adaptive: a ball only needs to be brighter than its background, not
  // brighter than some absolute value.  Default 30.
  brightnessThreshold: number
  minBlobPixels: number  // minimum blob area in 128×128 ROI-canvas space
  maxBlobPixels: number  // maximum blob area
  everyNthFrame: number  // analyze every N-th rAF frame
}

interface BlobResult {
  cx: number    // center x in ROI-canvas pixels [0..127]
  cy: number    // center y in ROI-canvas pixels [0..127]
  area: number  // pixel count
}

const CANVAS_SIZE = 128
const DETECT_FRAMES = 1   // frames with blob needed to fire onBallDetected (1 = instant feedback)
const LOSE_FRAMES   = 5   // consecutive empty frames before onBallLost fires

// Pure function — exported for unit testing.
// minAspect/maxAspect should be pre-corrected for ROI stretch so that a round
// ball in a non-square ROI (which appears oval in the square canvas) still passes.
export function findBestBlob(
  bright: Uint8Array,  // row-major w×h, 1 = above threshold, 0 = below
  w: number,
  h: number,
  minPixels: number,
  maxPixels: number,
  minAspect = 0.65,
  maxAspect = 1.55,
): BlobResult | null {
  const visited = new Uint8Array(w * h)
  let best: (BlobResult & { score: number }) | null = null

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (!bright[idx] || visited[idx]) continue

      let minX = x, maxX = x, minY = y, maxY = y
      let area = 0
      const queue: number[] = [idx]
      visited[idx] = 1
      let qi = 0

      while (qi < queue.length) {
        const cur = queue[qi++]
        const px = cur % w
        const py = (cur / w) | 0
        area++
        if (px < minX) minX = px
        if (px > maxX) maxX = px
        if (py < minY) minY = py
        if (py > maxY) maxY = py

        if (px > 0)     { const n = cur - 1; if (!visited[n] && bright[n]) { visited[n] = 1; queue.push(n) } }
        if (px < w - 1) { const n = cur + 1; if (!visited[n] && bright[n]) { visited[n] = 1; queue.push(n) } }
        if (py > 0)     { const n = cur - w; if (!visited[n] && bright[n]) { visited[n] = 1; queue.push(n) } }
        if (py < h - 1) { const n = cur + w; if (!visited[n] && bright[n]) { visited[n] = 1; queue.push(n) } }
      }

      if (area < minPixels || area > maxPixels) continue

      const bboxW = maxX - minX + 1
      const bboxH = maxY - minY + 1
      const aspect = bboxW / bboxH
      if (aspect < minAspect || aspect > maxAspect) continue

      // Compactness: a circle scores π/4 ≈ 0.785; reject clearly non-round blobs
      const score = area / (bboxW * bboxH)
      if (score < 0.55) continue

      if (!best || score > best.score) {
        best = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, area, score }
      }
    }
  }

  return best
}

export class BallDetector {
  private config: BallDetectorConfig
  private running = false
  private rafId: number | null = null
  private frameCount = 0
  private consecutiveWith = 0
  private consecutiveWithout = 0
  private ballConfirmed = false
  private _currentPos: BallPosition | null = null
  private onDetectedCb: ((pos: BallPosition) => void) | null = null
  private onLostCb: (() => void) | null = null
  private canvas: OffscreenCanvas | null = null
  private ctx: OffscreenCanvasRenderingContext2D | null = null
  private videoEl: HTMLVideoElement | null = null
  private getRoi: (() => NormalizedRect) | null = null
  private debugCtx: CanvasRenderingContext2D | null = null

  constructor(config: BallDetectorConfig) {
    this.config = { ...config }
  }

  start(videoEl: HTMLVideoElement, getRoi: () => NormalizedRect): void {
    this.videoEl = videoEl
    this.getRoi = getRoi
    this.running = true
    this.frameCount = 0
    this.consecutiveWith = 0
    this.consecutiveWithout = 0
    this.ballConfirmed = false
    this._currentPos = null
    this.canvas = new OffscreenCanvas(CANVAS_SIZE, CANVAS_SIZE)
    this.ctx = this.canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
    this._loop()
  }

  stop(): void {
    this.running = false
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null }
    this.canvas = null
    this.ctx = null
    this._currentPos = null
  }

  onBallDetected(cb: (pos: BallPosition) => void): void { this.onDetectedCb = cb }
  onBallLost(cb: () => void): void { this.onLostCb = cb }
  currentPosition(): BallPosition | null { return this._currentPos }
  updateConfig(patch: Partial<BallDetectorConfig>): void { this.config = { ...this.config, ...patch } }
  setDebugCanvas(el: HTMLCanvasElement | null): void {
    this.debugCtx = el ? el.getContext('2d') : null
  }

  private _loop(): void {
    if (!this.running) return
    this.rafId = requestAnimationFrame(() => {
      this.frameCount++
      if (this.frameCount % this.config.everyNthFrame === 0) this._analyzeFrame()
      this._loop()
    })
  }

  private _analyzeFrame(): void {
    const video = this.videoEl
    const ctx = this.ctx
    if (!video || !ctx || video.readyState < 2 || !this.getRoi) return

    const roi = this.getRoi()
    const vw = video.videoWidth  || CANVAS_SIZE
    const vh = video.videoHeight || CANVAS_SIZE

    // Draw only the ROI region stretched to the full canvas.
    // This gives ~4× better resolution than drawing the full frame and cropping,
    // which matters for golf balls that may be only a few pixels wide.
    const sw = roi.w * vw
    const sh = roi.h * vh
    if (sw < 1 || sh < 1) return
    ctx.drawImage(video, roi.x * vw, roi.y * vh, sw, sh, 0, 0, CANVAS_SIZE, CANVAS_SIZE)

    const data = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data
    const n = CANVAS_SIZE * CANVAS_SIZE

    // Adaptive threshold: mark pixels brighter than (mean + offset).
    // This handles any lighting condition — the ball only needs to be brighter
    // than its immediate background, not brighter than an absolute value.
    let sumLuma = 0
    for (let i = 0; i < n; i++) {
      sumLuma += 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
    }
    const meanLuma  = sumLuma / n
    const lumaFloor = meanLuma + this.config.brightnessThreshold

    const bright = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      bright[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) > lumaFloor ? 1 : 0
    }

    // A round ball in a non-square ROI appears oval in the square canvas.
    // Expected canvas aspect (blobW/blobH) of a round object = sh/sw.
    // Allow ±55% around that expected value so the check is tight enough to
    // reject elongated smears but tolerant of the ROI's stretch distortion.
    const expectedAspect = sh / sw
    const minAspect = Math.max(0.15, expectedAspect * 0.45)
    const maxAspect = Math.min(6.0,  expectedAspect * 2.2)

    const blob = findBestBlob(bright, CANVAS_SIZE, CANVAS_SIZE, this.config.minBlobPixels, this.config.maxBlobPixels, minAspect, maxAspect)
    this._renderDebug(data, bright, meanLuma, lumaFloor, blob)

    if (blob) {
      const nx = roi.x + (blob.cx / CANVAS_SIZE) * roi.w
      const ny = roi.y + (blob.cy / CANVAS_SIZE) * roi.h
      const radius = Math.sqrt(blob.area / Math.PI) / CANVAS_SIZE * Math.min(roi.w, roi.h)
      this._processPos({ nx, ny, radius })
    } else {
      this._processPos(null)
    }
  }

  private _renderDebug(
    data: Uint8ClampedArray,
    bright: Uint8Array,
    meanLuma: number,
    lumaFloor: number,
    blob: BlobResult | null,
  ): void {
    const dctx = this.debugCtx
    if (!dctx) return

    // Build a composite ImageData: dark pixels dimmed, bright pixels orange-tinted
    const out = new ImageData(CANVAS_SIZE, CANVAS_SIZE)
    const d = out.data
    for (let i = 0; i < bright.length; i++) {
      const o = i * 4
      if (bright[i]) {
        d[o]   = Math.min(255, data[o]   + 80)   // boost red
        d[o+1] = (data[o+1] * 0.5) | 0           // cut green
        d[o+2] = (data[o+2] * 0.4) | 0           // cut blue
        d[o+3] = 255
      } else {
        d[o]   = (data[o]   * 0.55) | 0
        d[o+1] = (data[o+1] * 0.55) | 0
        d[o+2] = (data[o+2] * 0.55) | 0
        d[o+3] = 255
      }
    }
    dctx.putImageData(out, 0, 0)

    // Green circle + crosshair on best blob
    if (blob) {
      const r = Math.max(2, Math.sqrt(blob.area / Math.PI))
      dctx.strokeStyle = 'rgba(34,197,94,0.95)'
      dctx.lineWidth = 1.5
      dctx.beginPath()
      dctx.arc(blob.cx, blob.cy, r, 0, Math.PI * 2)
      dctx.stroke()
      dctx.fillStyle = '#22c55e'
      dctx.fillRect(blob.cx - 1, blob.cy - 1, 3, 3)
    }

    // Stats bar
    const barH = 14
    dctx.fillStyle = 'rgba(0,0,0,0.8)'
    dctx.fillRect(0, CANVAS_SIZE - barH, CANVAS_SIZE, barH)
    dctx.fillStyle = '#cbd5e1'
    dctx.font = '8px monospace'
    const blobText = blob ? `blob ${blob.area}px` : 'no blob'
    dctx.fillText(`μ${meanLuma | 0}  thr${lumaFloor | 0}  ${blobText}`, 3, CANVAS_SIZE - 3)
  }

  // Bypasses video/canvas capture — feeds the state machine directly (for testing).
  _feedSyntheticPos(pos: BallPosition | null): void {
    this._processPos(pos)
  }

  private _processPos(pos: BallPosition | null): void {
    if (pos) {
      this.consecutiveWithout = 0
      this.consecutiveWith++
      if (this.consecutiveWith >= DETECT_FRAMES) {
        this._currentPos = pos
        if (!this.ballConfirmed) this.ballConfirmed = true
        this.onDetectedCb?.(pos)
      }
    } else {
      this.consecutiveWith = 0
      this.consecutiveWithout++
      if (this.ballConfirmed && this.consecutiveWithout >= LOSE_FRAMES) {
        this.ballConfirmed = false
        this._currentPos = null
        this.onLostCb?.()
      }
    }
  }
}
