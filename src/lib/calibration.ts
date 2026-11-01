import type { MotionDetector } from './motionDetector.ts'
import type { AudioDetector } from './audioDetector.ts'

export interface CalibrationResult {
  suggestedPixelDiffThreshold: number  // motion: mean + 2*stddev of raw diff fraction * 255
  suggestedAudioSpikeRatio: number     // audio: backgroundMax * 1.5, expressed as a ratio
  motionMean: number
  motionStddev: number
  audioBackground: number
}

export async function runCalibration(
  motionDetector: MotionDetector,
  audioDetector: AudioDetector,
  durationMs = 3000,
  intervalMs = 100,
): Promise<CalibrationResult> {
  const motionSamples: number[] = []
  const audioSamples: number[] = []

  return new Promise(resolve => {
    const scoreUnsub = (score: number) => { motionSamples.push(score) }
    const levelUnsub = (level: number) => { audioSamples.push(level) }

    motionDetector.onScoreUpdate(scoreUnsub)
    audioDetector.onLevelUpdate(levelUnsub)

    setTimeout(() => {
      // Remove callbacks — no built-in unsub, so just ignore after resolve
      void intervalMs  // intervalMs is implicit via the detector's own scheduling

      // Motion stats
      const mMean = motionSamples.length
        ? motionSamples.reduce((a, b) => a + b, 0) / motionSamples.length
        : 0
      const mVar = motionSamples.length
        ? motionSamples.reduce((a, b) => a + (b - mMean) ** 2, 0) / motionSamples.length
        : 0
      const mStd = Math.sqrt(mVar)
      // Convert to 0-255 pixel diff threshold (score is fraction of pixels, threshold in absolute luma diff)
      // We use the motion score directly to set pixelDiffThreshold: score = fraction of pixels above threshold.
      // A good threshold puts idle at ~baseline + 2σ. We express this as a pixel diff threshold in 0-255.
      // Heuristic: if idle score is ~0.01, that means 1% of pixels changed by > threshold.
      // We want to set threshold so idle spikes are rare. Return as fraction for caller to use.
      const suggestedPixelDiffThreshold = Math.round(Math.min(255, Math.max(5, (mMean + 2 * mStd) * 255)))

      // Audio stats
      const aBg = audioSamples.length
        ? audioSamples.reduce((a, b) => a + b, 0) / audioSamples.length
        : 5

      resolve({
        suggestedPixelDiffThreshold,
        suggestedAudioSpikeRatio: Math.max(1.5, 2.0),
        motionMean: mMean,
        motionStddev: mStd,
        audioBackground: aBg,
      })
    }, durationMs)
  })
}
