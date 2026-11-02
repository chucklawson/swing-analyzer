import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SwingFusion, type RejectionReason, type SwingFusionConfig } from './swingFusion.ts'

function makeFusion(overrides: Partial<SwingFusionConfig> = {}) {
  return new SwingFusion({
    fusionWindowMs: 400,
    audioLookbackMs: 400,
    cooldownMs: 3000,
    audioOnlyMode: false,
    ...overrides,
  })
}

describe('SwingFusion', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('fires when motion precedes audio within lookback window', () => {
    const f = makeFusion()
    const swings: number[] = []
    f.onSwing(ts => swings.push(ts))

    const motionTs = 1000
    const audioTs  = 1300  // 300ms gap — within 400ms lookback
    f.feedMotionSpike(motionTs)
    f.feedAudioImpact(audioTs, 50)
    expect(swings).toHaveLength(1)
    expect(swings[0]).toBe(audioTs)
  })

  it('uses audio timestamp (not motion timestamp) for the swing event', () => {
    const f = makeFusion()
    const swings: number[] = []
    f.onSwing(ts => swings.push(ts))

    f.feedMotionSpike(1000)
    f.feedAudioImpact(1250, 60)
    expect(swings[0]).toBe(1250)
  })

  it('rejects audio-only (no preceding motion)', () => {
    const f = makeFusion()
    const rejections: RejectionReason[] = []
    f.onRejected(r => rejections.push(r))

    f.feedAudioImpact(1000, 50)
    expect(rejections).toContain('audio-only')
    expect(rejections).not.toContain('cooldown')
  })

  it('rejects when motion spike is outside audioLookbackMs window', () => {
    const f = makeFusion({ audioLookbackMs: 400 })
    const rejections: RejectionReason[] = []
    f.onRejected(r => rejections.push(r))
    const swings: number[] = []
    f.onSwing(() => swings.push(1))

    f.feedMotionSpike(1000)
    f.feedAudioImpact(1500, 50)  // 500ms gap > 400ms lookback
    expect(swings).toHaveLength(0)
    expect(rejections).toContain('audio-only')
  })

  it('fires when backswing motion is within 2000ms audioLookbackMs', () => {
    const f = makeFusion({ audioLookbackMs: 2000 })
    const swings: number[] = []
    f.onSwing(ts => swings.push(ts))

    f.feedMotionSpike(1000)       // backswing
    f.feedAudioImpact(2500, 80)   // ball strike 1500ms later — within 2000ms lookback
    expect(swings).toHaveLength(1)
    expect(swings[0]).toBe(2500)
  })

  it('rejects clap with no preceding motion', () => {
    const f = makeFusion({ audioLookbackMs: 2000 })
    const rejections: RejectionReason[] = []
    f.onRejected(r => rejections.push(r))
    const swings: number[] = []
    f.onSwing(() => swings.push(1))

    f.feedAudioImpact(5000, 80)
    expect(swings).toHaveLength(0)
    expect(rejections).toContain('audio-only')
  })

  it('stores audio-only impact when motion arrives well after (bidirectional)', () => {
    const f = makeFusion()
    const rejections: RejectionReason[] = []
    f.onRejected(r => rejections.push(r))

    f.feedMotionSpike(1200)
    f.feedAudioImpact(1000, 50)
    expect(rejections).toContain('audio-only')
  })

  it('blocks second fire during cooldown', () => {
    const f = makeFusion({ cooldownMs: 3000 })
    const swings: number[] = []
    const rejections: RejectionReason[] = []
    f.onSwing(() => swings.push(1))
    f.onRejected(r => rejections.push(r))

    f.feedMotionSpike(1000)
    f.feedAudioImpact(1200, 50)
    expect(swings).toHaveLength(1)

    f.feedMotionSpike(2000)
    f.feedAudioImpact(2200, 50)
    expect(swings).toHaveLength(1)
    expect(rejections).toContain('cooldown')
  })

  it('fires again after cooldown expires', () => {
    const f = makeFusion({ cooldownMs: 3000 })
    const swings: number[] = []
    f.onSwing(() => swings.push(1))

    f.feedMotionSpike(1000)
    f.feedAudioImpact(1200, 50)
    expect(swings).toHaveLength(1)

    vi.advanceTimersByTime(3100)

    f.feedMotionSpike(4500)
    f.feedAudioImpact(4700, 50)
    expect(swings).toHaveLength(2)
  })

  it('calls onCooldownEnd when cooldown expires', () => {
    const f = makeFusion({ cooldownMs: 3000 })
    let ended = false
    f.onCooldownEnd(() => { ended = true })

    f.feedMotionSpike(1000)
    f.feedAudioImpact(1200, 50)
    expect(ended).toBe(false)

    vi.advanceTimersByTime(3001)
    expect(ended).toBe(true)
  })

  it('audioOnlyMode fires immediately on audio with no motion check', () => {
    const f = makeFusion({ audioOnlyMode: true })
    const swings: number[] = []
    f.onSwing(ts => swings.push(ts))

    f.feedAudioImpact(1000, 80)
    expect(swings).toHaveLength(1)
    expect(swings[0]).toBe(1000)
  })

  it('audioOnlyMode still respects cooldown', () => {
    const f = makeFusion({ audioOnlyMode: true, cooldownMs: 3000 })
    const swings: number[] = []
    const rejections: RejectionReason[] = []
    f.onSwing(() => swings.push(1))
    f.onRejected(r => rejections.push(r))

    f.feedAudioImpact(1000, 80)
    expect(swings).toHaveLength(1)

    f.feedAudioImpact(2000, 80)
    expect(swings).toHaveLength(1)
    expect(rejections).toContain('cooldown')
  })

  it('reset clears state and allows immediate re-fire', () => {
    const f = makeFusion({ cooldownMs: 3000 })
    const swings: number[] = []
    f.onSwing(() => swings.push(1))

    f.feedMotionSpike(1000)
    f.feedAudioImpact(1200, 50)
    expect(swings).toHaveLength(1)

    f.reset()
    f.feedMotionSpike(2000)
    f.feedAudioImpact(2200, 50)
    expect(swings).toHaveLength(2)
  })

  it('accepts audio within 50ms before motion (simultaneous tolerance)', () => {
    const f = makeFusion()
    const swings: number[] = []
    const rejections: RejectionReason[] = []
    f.onSwing(() => swings.push(1))
    f.onRejected(r => rejections.push(r))

    f.feedMotionSpike(1000)
    f.feedAudioImpact(995, 50)
    expect(swings).toHaveLength(1)
    expect(rejections).not.toContain('audio-only')
  })

  it('fires when audio callback arrives before motion callback (bidirectional)', () => {
    const f = makeFusion({ fusionWindowMs: 400 })
    const swings: number[] = []
    const rejections: RejectionReason[] = []
    f.onSwing(ts => swings.push(ts))
    f.onRejected(r => rejections.push(r))

    f.feedAudioImpact(1000, 80)
    expect(rejections).toContain('audio-only')
    expect(swings).toHaveLength(0)

    f.feedMotionSpike(1033)
    expect(swings).toHaveLength(1)
    expect(swings[0]).toBe(1000)
  })

  it('does not fire on stale audio when motion arrives outside fusionWindowMs (bidirectional)', () => {
    const f = makeFusion({ fusionWindowMs: 400 })
    const swings: number[] = []
    f.onSwing(() => swings.push(1))

    f.feedAudioImpact(1000, 80)
    f.feedMotionSpike(1500)
    expect(swings).toHaveLength(0)
  })
})
