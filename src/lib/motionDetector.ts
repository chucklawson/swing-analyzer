import type { SwingConfig, NormalizedRect } from './swingConfig.ts'

type SpikeCallback = (ts: number, score: number) => void
type ScoreCallback = (score: number) => void

// Feature detection — evaluated once at module load
const supportsRVFC = typeof HTMLVideoElement !== 'undefined' &&
  'requestVideoFrameCallback' in HTMLVideoElement.prototype

function makeCanvas(size: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(size, size)
  }
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  return c
}

export type MotionDetectorConfig = Pick<SwingConfig, 'analysisSize'|'pixelDiffThreshold'|'spikeRatio'|'baselineWindowSize'|'everyNthFrame'>

export class MotionDetector {
  private config: MotionDetectorConfig
  private spikeCallbacks: SpikeCallback[] = []
  private scoreCallbacks: ScoreCallback[] = []

  private canvas: OffscreenCanvas | HTMLCanvasElement | null = null
  private ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null
  private prevLuma: Uint8Array | null = null
  private currLuma: Uint8Array | null = null
  private baseline: Float64Array | null = null  // circular buffer
  private baselineIdx = 0
  private baselineFilled = false
  private _currentScore = 0
  private _currentBaseline = 0

  private videoEl: HTMLVideoElement | null = null
  private getRoi: (() => NormalizedRect) | null = null
  private frameCount = 0
  private rafId: number | null = null
  private rvfcHandle: number | null = null
  private running = false

  constructor(config: MotionDetectorConfig) {
    this.config = { ...config }
  }

  onSpike(cb: SpikeCallback) { this.spikeCallbacks.push(cb) }
  onScoreUpdate(cb: ScoreCallback) { this.scoreCallbacks.push(cb) }
  currentScore() { return this._currentScore }
  currentBaseline() { return this._currentBaseline }

  updateConfig(patch: Partial<MotionDetectorConfig>) {
    this.config = { ...this.config, ...patch }
  }

  start(videoEl: HTMLVideoElement, getRoi: () => NormalizedRect) {
    this.stop()
    this.videoEl = videoEl
    this.getRoi = getRoi
    this.running = true

    const size = this.config.analysisSize
    this.canvas = makeCanvas(size)
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true }) as
      OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
    this.prevLuma = new Uint8Array(size * size)
    this.currLuma = new Uint8Array(size * size)
    this.baseline = new Float64Array(this.config.baselineWindowSize)
    this.baselineIdx = 0
    this.baselineFilled = false
    this.frameCount = 0

    if (supportsRVFC) {
      this.scheduleRVFC()
    } else {
      this.scheduleRAF()
    }
  }

  stop() {
    this.running = false
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null }
    if (this.rvfcHandle !== null && this.videoEl) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(this.videoEl as any).cancelVideoFrameCallback(this.rvfcHandle)
      this.rvfcHandle = null
    }
    this.videoEl = null
    this.getRoi = null
  }

  // --- frame scheduling ---

  private scheduleRVFC() {
    if (!this.running || !this.videoEl) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.rvfcHandle = (this.videoEl as any).requestVideoFrameCallback(
      (_now: number, _meta: unknown) => {
        this.processFrame()
        this.scheduleRVFC()
      },
    )
  }

  private scheduleRAF() {
    if (!this.running) return
    this.rafId = requestAnimationFrame(() => {
      this.processFrame()
      this.scheduleRAF()
    })
  }

  // --- core computation ---

  processFrame() {
    this.frameCount++
    if (this.frameCount % this.config.everyNthFrame !== 0) return

    const video = this.videoEl
    const ctx   = this.ctx
    const prev  = this.prevLuma
    const curr  = this.currLuma
    if (!video || !ctx || !prev || !curr || !this.getRoi || !this.baseline) return
    if (video.readyState < 2) return

    const roi = this.getRoi()
    const size = this.config.analysisSize

    // Draw ROI slice onto the small canvas
    ctx.drawImage(
      video,
      roi.x * video.videoWidth,
      roi.y * video.videoHeight,
      roi.w * video.videoWidth,
      roi.h * video.videoHeight,
      0, 0, size, size,
    )

    const imageData = ctx.getImageData(0, 0, size, size)
    const pixels = imageData.data

    // Convert to luma (BT.601) into curr buffer
    let lumaSum = 0
    for (let i = 0; i < size * size; i++) {
      const r = pixels[i * 4]!
      const g = pixels[i * 4 + 1]!
      const b = pixels[i * 4 + 2]!
      const luma = 0.299 * r + 0.587 * g + 0.114 * b
      curr[i] = luma
      lumaSum += luma
    }

    // Normalize by mean luminance to suppress auto-exposure changes
    const lumaMean = lumaSum / (size * size)
    const scale = lumaMean > 0 ? 128 / lumaMean : 1

    let diffCount = 0
    const threshold = this.config.pixelDiffThreshold
    for (let i = 0; i < size * size; i++) {
      const normCurr = Math.min(255, curr[i]! * scale)
      const normPrev = Math.min(255, prev[i]! * scale)
      if (Math.abs(normCurr - normPrev) > threshold) diffCount++
    }

    // Swap buffers
    const tmp = this.prevLuma!
    this.prevLuma = this.currLuma!
    this.currLuma = tmp

    const score = diffCount / (size * size)
    this._currentScore = score
    for (const cb of this.scoreCallbacks) cb(score)

    // Update rolling baseline
    this.baseline[this.baselineIdx] = score
    this.baselineIdx = (this.baselineIdx + 1) % this.config.baselineWindowSize
    if (this.baselineIdx === 0) this.baselineFilled = true

    const count = this.baselineFilled ? this.config.baselineWindowSize : this.baselineIdx
    let baselineSum = 0
    for (let i = 0; i < count; i++) baselineSum += this.baseline[i]!
    this._currentBaseline = count > 0 ? baselineSum / count : 0

    // Spike detection
    if (this._currentBaseline > 0 && score > this._currentBaseline * this.config.spikeRatio) {
      const ts = Date.now()
      for (const cb of this.spikeCallbacks) cb(ts, score)
    }
  }

  /**
   * Inject a score directly (used by tests to drive the detector without a real video).
   * Runs through baseline update and spike detection exactly as processFrame does.
   */
  injectScore(score: number) {
    if (!this.baseline) {
      this.baseline = new Float64Array(this.config.baselineWindowSize)
      this.baselineIdx = 0
      this.baselineFilled = false
    }
    this._currentScore = score
    for (const cb of this.scoreCallbacks) cb(score)

    this.baseline[this.baselineIdx] = score
    this.baselineIdx = (this.baselineIdx + 1) % this.config.baselineWindowSize
    if (this.baselineIdx === 0) this.baselineFilled = true

    const count = this.baselineFilled ? this.config.baselineWindowSize : this.baselineIdx
    let sum = 0
    for (let i = 0; i < count; i++) sum += this.baseline[i]!
    this._currentBaseline = count > 0 ? sum / count : 0

    if (this._currentBaseline > 0 && score > this._currentBaseline * this.config.spikeRatio) {
      const ts = Date.now()
      for (const cb of this.spikeCallbacks) cb(ts, score)
    }
  }
}
