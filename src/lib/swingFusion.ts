import type { SwingConfig } from './swingConfig.ts'

export type RejectionReason = 'audio-only' | 'motion-only' | 'cooldown' | 'ordering'

type SwingCallback    = (audioTs: number) => void
type RejectedCallback = (reason: RejectionReason, ts: number) => void

export type SwingFusionConfig = Pick<SwingConfig, 'fusionWindowMs' | 'audioLookbackMs' | 'cooldownMs' | 'audioOnlyMode'>

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

  }

  feedAudioImpact(audioTs: number, _level: number) {
    if (this.inCooldown(audioTs)) {
      for (const cb of this.rejectedCallbacks) cb('cooldown', audioTs)
      return
    }

    if (this.config.audioOnlyMode) {
      if (this.motionOnlyTimer !== null) { clearTimeout(this.motionOnlyTimer); this.motionOnlyTimer = null }
      this.fire(audioTs)
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
    // Audio-first model: hear the bang, look back up to audioLookbackMs for any motion.
    // Motion arriving up to 50ms after audio is still valid (RAF callback timing jitter).
    if (gap < -50) {
      // Motion arrived well after audio — store audio for bidirectional match
      this.lastAudioImpactTs = audioTs
      for (const cb of this.rejectedCallbacks) cb('audio-only', audioTs)
      return
    }
    if (gap > this.config.audioLookbackMs) {
      // No motion within lookback window — likely a clap or noise, not a swing
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
