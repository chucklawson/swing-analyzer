import type { AudioDetector } from './audioDetector.ts'

export interface CalibrationResult {
  suggestedAudioSpikeRatio: number
  audioBackground: number
}

export async function runCalibration(
  _motionDetector: null,
  audioDetector: AudioDetector,
  durationMs = 3000,
): Promise<CalibrationResult> {
  const audioSamples: number[] = []

  return new Promise(resolve => {
    audioDetector.onLevelUpdate((level: number) => { audioSamples.push(level) })

    setTimeout(() => {
      const aBg = audioSamples.length
        ? audioSamples.reduce((a, b) => a + b, 0) / audioSamples.length
        : 5

      resolve({
        suggestedAudioSpikeRatio: Math.max(1.5, 2.0),
        audioBackground: aBg,
      })
    }, durationMs)
  })
}
