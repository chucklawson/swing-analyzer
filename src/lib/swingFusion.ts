import type { SwingConfig } from './swingConfig.ts'

export type RejectionReason = 'audio-only' | 'motion-only' | 'cooldown' | 'ordering'

type SwingCallback    = (audioTs: number) => void
type RejectedCallback = (reason: RejectionReason, ts: number) => void

export type SwingFusionConfig = Pick<SwingConfig, 'fusionWindowMs' | 'cooldownMs' | 'motionOnlyMode'>

export class SwingFusion {
  private config: SwingFusionConfig
  private swingCallbacks: SwingCallback[] = []
  private rejectedCallbacks: RejectedCallback[] = []

  private lastMotionSpikeTs: number | null = null
  private cooldownUntil: number | null = null
  // Callback invoked by fusion when cooldown expires (lets the host reset its own flag)
  private onCooldownEndCb: (() => void) | null = null
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null

  // Motion-only mode: if a spike comes in but no audio within fusionWindowMs, fire anyway
  private motionOnlyTimer: ReturnType<typeof setTimeout> | null = null

  constructor(config: SwingFusionConfig) {
    this.config = { ...config }
  }

  onSwing(cb: SwingCallback) { this.swingCallbacks.push(cb) }
  onRejected(cb: RejectedCallback) { this.rejectedCallbacks.push(cb) }
  onCooldownEnd(cb: () => void) { this.onCooldownEndCb = cb }

  updateConfig(patch: Partial<SwingFusionConfig>) {
    this.config = { ...this.config, ...patch }
  }

  reset() {
    if (this.cooldownTimer !== null) { clearTimeout(this.cooldownTimer); this.cooldownTimer = null }
    if (this.motionOnlyTimer !== null) { clearTimeout(this.motionOnlyTimer); this.motionOnlyTimer = null }
    this.lastMotionSpikeTs = null
    this.cooldownUntil = null
  }

  inCooldown(now: number = Date.now()): boolean {
    return this.cooldownUntil !== null && now < this.cooldownUntil
  }

  feedMotionSpike(ts: number) {
    if (this.inCooldown(ts)) return

    this.lastMotionSpikeTs = ts

    if (this.config.motionOnlyMode) {
      // Fire after fusionWindowMs if no audio comes in
      if (this.motionOnlyTimer !== null) clearTimeout(this.motionOnlyTimer)
      this.motionOnlyTimer = setTimeout(() => {
        this.motionOnlyTimer = null
        if (this.inCooldown()) return
        // Only fire if no audio has resolved this spike already (lastMotionSpikeTs unchanged)
        if (this.lastMotionSpikeTs === ts) {
          this.fire(ts)
        }
      }, this.config.fusionWindowMs + 50)
    }
  }

  feedAudioImpact(audioTs: number, _level: number) {
    if (this.inCooldown(audioTs)) {
      for (const cb of this.rejectedCallbacks) cb('cooldown', audioTs)
      return
    }

    const motionTs = this.lastMotionSpikeTs

    if (motionTs === null) {
      for (const cb of this.rejectedCallbacks) cb('audio-only', audioTs)
      return
    }

    const gap = audioTs - motionTs
    // Motion must precede audio by at most fusionWindowMs, or be within 50ms after
    if (gap < -50) {
      // Audio came before motion (or motion is in the future) — reject
      for (const cb of this.rejectedCallbacks) cb('ordering', audioTs)
      return
    }
    if (gap > this.config.fusionWindowMs) {
      // Motion spike is too old
      for (const cb of this.rejectedCallbacks) cb('audio-only', audioTs)
      return
    }

    // Cancel pending motion-only timer since audio resolved the event
    if (this.motionOnlyTimer !== null) { clearTimeout(this.motionOnlyTimer); this.motionOnlyTimer = null }

    this.fire(audioTs)
  }

  private fire(audioTs: number) {
    this.lastMotionSpikeTs = null
    this.cooldownUntil = audioTs + this.config.cooldownMs

    if (this.cooldownTimer !== null) clearTimeout(this.cooldownTimer)
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null
      this.cooldownUntil = null
      if (this.onCooldownEndCb) this.onCooldownEndCb()
    }, this.config.cooldownMs)

    for (const cb of this.swingCallbacks) cb(audioTs)
  }
}
