import type { SwingConfig } from './swingConfig.ts'

type ImpactCallback = (ts: number, level: number) => void
type LevelCallback  = (level: number) => void

export type AudioDetectorConfig = Pick<SwingConfig, 'audioSpikeRatio' | 'audioBackgroundWindow'>

export class AudioDetector {
  private config: AudioDetectorConfig
  private analyser: AnalyserNode
  private buf: Uint8Array<ArrayBuffer>
  private impactCallbacks: ImpactCallback[] = []
  private levelCallbacks: LevelCallback[] = []
  private rafId: number | null = null

  // Rolling background: track max-peak over a sliding window
  private bgSamples: { ts: number; peak: number }[] = []
  private _bgLevel = 0
  private _level = 0

  constructor(analyser: AnalyserNode, config: AudioDetectorConfig) {
    this.analyser = analyser
    this.config = { ...config }
    this.buf = new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>
  }

  onImpact(cb: ImpactCallback) { this.impactCallbacks.push(cb) }
  onLevelUpdate(cb: LevelCallback) { this.levelCallbacks.push(cb) }
  currentLevel() { return this._level }
  backgroundLevel() { return this._bgLevel }

  updateConfig(patch: Partial<AudioDetectorConfig>) {
    this.config = { ...this.config, ...patch }
  }

  start() {
    const tick = () => {
      this.analyser.getByteTimeDomainData(this.buf)
      let peak = 0
      for (const v of this.buf) peak = Math.max(peak, Math.abs(v - 128))
      const pct = Math.round((peak / 128) * 100)
      this._level = pct
      for (const cb of this.levelCallbacks) cb(pct)

      const now = Date.now()
      // Update rolling background
      this.bgSamples.push({ ts: now, peak: pct })
      const cutoff = now - this.config.audioBackgroundWindow
      this.bgSamples = this.bgSamples.filter(s => s.ts >= cutoff)
      // Background = median of recent samples (robust to single loud events)
      const sorted = this.bgSamples.map(s => s.peak).sort((a, b) => a - b)
      this._bgLevel = sorted[Math.floor(sorted.length / 2)] ?? 0

      const bg = this._bgLevel
      // Fire impact when peak is significantly above background.
      // Guard against a zero/near-zero background producing spurious fires.
      if (bg >= 2 && pct >= bg * this.config.audioSpikeRatio) {
        for (const cb of this.impactCallbacks) cb(now, pct)
      }

      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  stop() {
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null }
    this.bgSamples = []
  }
}
