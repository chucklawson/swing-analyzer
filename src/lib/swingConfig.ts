export interface NormalizedRect {
  x: number  // 0..1 left edge
  y: number  // 0..1 top edge
  w: number  // 0..1 width
  h: number  // 0..1 height
}

export interface SwingConfig {
  // audio
  audioSpikeRatio: number      // peak/background ratio to fire
  audioBackgroundWindow: number // background rolling window in ms
  // fusion
  fusionWindowMs: number       // ms window for bidirectional audio/motion RAF timing jitter
  audioLookbackMs: number      // how far back to look for motion when audio impact fires
  cooldownMs: number           // ms before fusion can fire again
  audioOnlyMode: boolean       // always true now (no motion detection)
  // audio input
  micGain: number                      // GainNode multiplier applied before analyser
  // ball detection
  ballDetectionEnabled: boolean
  ballBrightnessThreshold: number  // luma units above ROI mean (adaptive offset, not absolute)
  ballMinPixels: number            // minimum blob area in 128×128 space
  ballMaxPixels: number            // maximum blob area
  // roi
  roi: NormalizedRect
  // ui
  showDebugPanel: boolean
  traceEnabled: boolean
}

export const DEFAULT_CONFIG: SwingConfig = {
  audioSpikeRatio: 2.5,
  audioBackgroundWindow: 2000,
  fusionWindowMs: 400,
  audioLookbackMs: 2000,
  cooldownMs: 7000,
  audioOnlyMode: true,
  micGain: 4,
  ballDetectionEnabled: true,
  ballBrightnessThreshold: 30,
  ballMinPixels: 2,
  ballMaxPixels: 6000,
  roi: { x: 0.2, y: 0.15, w: 0.6, h: 0.7 },
  showDebugPanel: false,
  traceEnabled: false,
}

const CONFIG_KEY = 'swing-config'

export function loadConfig(): SwingConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (!raw) return { ...DEFAULT_CONFIG }
    const saved = JSON.parse(raw) as Partial<SwingConfig>
    // audioOnlyMode is always true — motion detection is not active
    return { ...DEFAULT_CONFIG, ...saved, audioOnlyMode: true }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(c: SwingConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(c))
  } catch { /* non-fatal */ }
}
