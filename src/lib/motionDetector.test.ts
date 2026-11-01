import { describe, it, expect, vi } from 'vitest'
import { MotionDetector, type MotionDetectorConfig } from './motionDetector.ts'

function makeDetector(overrides: Partial<MotionDetectorConfig> = {}) {
  return new MotionDetector({
    analysisSize: 64,
    pixelDiffThreshold: 15,
    spikeRatio: 3.0,
    baselineWindowSize: 10,
    everyNthFrame: 1,
    ...overrides,
  })
}

describe('MotionDetector baseline and spike detection (synthetic)', () => {
  it('flat low-score sequence never fires a spike', () => {
    const d = makeDetector()
    const spikes: number[] = []
    d.onSpike(() => spikes.push(1))

    for (let i = 0; i < 20; i++) d.injectScore(0.01)
    expect(spikes).toHaveLength(0)
  })

  it('baseline starts at 0, increases as scores accumulate', () => {
    const d = makeDetector()
    d.injectScore(0.1)
    expect(d.currentBaseline()).toBeGreaterThan(0)
  })

  it('step-up score fires a spike after baseline is established', () => {
    const d = makeDetector({ spikeRatio: 3.0, baselineWindowSize: 10 })
    const spikes: number[] = []
    d.onSpike(() => spikes.push(1))

    // Establish baseline of ~0.01
    for (let i = 0; i < 10; i++) d.injectScore(0.01)
    expect(d.currentBaseline()).toBeCloseTo(0.01, 3)

    // Inject a spike score: 0.01 * 3.0 = 0.03, so 0.05 should fire
    d.injectScore(0.05)
    expect(spikes).toHaveLength(1)
  })

  it('score exactly at spikeRatio * baseline does NOT fire (strict >)', () => {
    const d = makeDetector({ spikeRatio: 3.0, baselineWindowSize: 10 })
    const spikes: number[] = []
    d.onSpike(() => spikes.push(1))

    for (let i = 0; i < 10; i++) d.injectScore(0.01)
    const threshold = d.currentBaseline() * 3.0
    d.injectScore(threshold)  // exactly at threshold — should NOT fire
    expect(spikes).toHaveLength(0)
  })

  it('spike fires with a Date.now() timestamp', () => {
    const d = makeDetector()
    const timestamps: number[] = []
    d.onSpike((ts) => timestamps.push(ts))

    vi.useFakeTimers()
    vi.setSystemTime(1000000)

    for (let i = 0; i < 10; i++) d.injectScore(0.01)
    d.injectScore(0.1)

    expect(timestamps).toHaveLength(1)
    expect(timestamps[0]).toBe(1000000)
    vi.useRealTimers()
  })

  it('baseline adapts after sustained elevation, suppressing further spikes', () => {
    const d = makeDetector({ spikeRatio: 3.0, baselineWindowSize: 5 })
    const spikes: number[] = []
    d.onSpike(() => spikes.push(1))

    // Establish low baseline
    for (let i = 0; i < 5; i++) d.injectScore(0.01)
    const initialSpikes = spikes.length

    // Inject sustained elevation: each score may initially spike, but baseline rises
    for (let i = 0; i < 30; i++) d.injectScore(0.05)
    // After window is filled with 0.05, baseline ≈ 0.05, threshold = 0.15
    // None of these should spike (0.05 is not > 0.05 * 3 = 0.15)
    const spikesAfterElevation = spikes.length - initialSpikes
    // There may be a few spikes right at the transition, but after adaptation it stops
    expect(d.currentBaseline()).toBeCloseTo(0.05, 2)
    // Last score (0.05) should not cause a spike because baseline ≈ 0.05
    // Verify no spike was fired on the very last injection
    const beforeLast = spikes.length
    d.injectScore(0.05)
    expect(spikes.length).toBe(beforeLast)

    // Suppress unused variable warning
    void spikesAfterElevation
  })

  it('multiple onSpike callbacks all fire', () => {
    const d = makeDetector()
    const a: number[] = []
    const b: number[] = []
    d.onSpike(() => a.push(1))
    d.onSpike(() => b.push(1))

    for (let i = 0; i < 10; i++) d.injectScore(0.01)
    d.injectScore(0.1)

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  it('updateConfig changes spikeRatio mid-run', () => {
    const d = makeDetector({ spikeRatio: 3.0 })
    const spikes: number[] = []
    d.onSpike(() => spikes.push(1))

    for (let i = 0; i < 10; i++) d.injectScore(0.01)
    // With ratio 3.0, score 0.05 fires (0.01*3=0.03 < 0.05)
    d.injectScore(0.05)
    expect(spikes).toHaveLength(1)

    // Raise ratio so 0.05 no longer fires
    d.updateConfig({ spikeRatio: 10.0 })
    for (let i = 0; i < 10; i++) d.injectScore(0.01)
    d.injectScore(0.05)
    // 0.01 * 10 = 0.1 > 0.05 → should NOT fire again
    expect(spikes).toHaveLength(1)
  })
})
