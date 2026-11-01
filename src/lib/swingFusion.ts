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
  // Stores the timestamp of the most recent audio impact that was rejected as
  // 'audio-only' (no motion at the time). Used for bidirectional matching: when a
  // motion spike arrives after audio, we can still pair them within the window.
  private lastAudioImpactTs: number | null = null
  private cooldownUntil: number | null = null
  private onCooldownEndCb: (() => void) | null = null
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null
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
    this.lastAudioImpactTs = null
    this.cooldownUntil = null
  }

  inCooldown(now: number = Date.now()): boolean {
    return this.cooldownUntil !== null && now < this.cooldownUntil
  }

  feedMotionSpike(ts: number) {
    if (this.inCooldown(ts)) return

    this.lastMotionSpikeTs = ts

    // Bidirectional check: if an audio impact was already rejected as 'audio-only'
    // (no motion at the time it fired), pair it with this motion spike.
    // This fixes the common iOS timing issue where the audio RAF callback fires
    // before the RVFC motion callback for the same swing — the audio was correctly
    // rejected at the time, but the follow-through motion spike arrives shortly after.
    const audioTs = this.lastAudioImpactTs
    if (audioTs !== null) {
      const gap = ts - audioTs   // positive: motion arrived after audio
      if (gap >= 0 && gap <= this.config.fusionWindowMs) {
        if (this.motionOnlyTimer !== null) { clearTimeout(this.motionOnlyTimer); this.motionOnlyTimer = null }
        this.fire(audioTs)
        return
      }
    }

    if (this.config.motionOnlyMode) {
      if (this.motionOnlyTimer !== null) clearTimeout(this.motionOnlyTimer)
      this.motionOnlyTimer = setTimeout(() => {
        this.motionOnlyTimer = null
        if (this.inCooldown()) return
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
      // No recent motion — store so feedMotionSpike can find it via bidirectional check
      this.lastAudioImpactTs = audioTs
      for (const cb of this.rejectedCallbacks) cb('audio-only', audioTs)
      return
    }

    const gap = audioTs - motionTs
    // Motion must precede audio by at most fusionWindowMs, or arrive within 50ms after
    if (gap < -50) {
      // Audio arrived >50ms before motion — ordering violation; don't store (invalid pair)
      for (const cb of this.rejectedCallbacks) cb('ordering', audioTs)
      return
    }
    if (gap > this.config.fusionWindowMs) {
      // Motion spike too old — store for bidirectional match with next motion spike
      this.lastAudioImpactTs = audioTs
      for (const cb of this.rejectedCallbacks) cb('audio-only', audioTs)
      return
    }

    if (this.motionOnlyTimer !== null) { clearTimeout(this.motionOnlyTimer); this.motionOnlyTimer = null }
    this.fire(audioTs)
  }

  private fire(audioTs: number) {
    this.lastMotionSpikeTs = null
    this.lastAudioImpactTs = null
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
