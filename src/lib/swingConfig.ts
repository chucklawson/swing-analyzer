export interface NormalizedRect {
  x: number  // 0..1 left edge
  y: number  // 0..1 top edge
  w: number  // 0..1 width
  h: number  // 0..1 height
}

export interface SwingConfig {
  // motion
  analysisSize: number         // offscreen canvas side in px
  pixelDiffThreshold: number   // 0-255 luma diff to count as changed pixel
  spikeRatio: number           // score/baseline ratio to declare a spike
  baselineWindowSize: number   // rolling window sample count for baseline
  everyNthFrame: number        // analyse every Nth video frame (1 = every frame)
  // audio
  audioSpikeRatio: number      // peak/background ratio to fire
  audioBackgroundWindow: number // background rolling window in ms
  // fusion
  fusionWindowMs: number       // max ms between motion spike and audio impact
  cooldownMs: number           // ms before fusion can fire again
  motionOnlyMode: boolean      // save clips on motion alone (default off)
  // roi
  roi: NormalizedRect
  // ui
  showDebugPanel: boolean
  traceEnabled: boolean
}

export const DEFAULT_CONFIG: SwingConfig = {
  analysisSize: 64,
  pixelDiffThreshold: 15,
  spikeRatio: 3.0,
  baselineWindowSize: 30,
  everyNthFrame: 2,
  audioSpikeRatio: 2.5,
  audioBackgroundWindow: 2000,
  fusionWindowMs: 400,
  cooldownMs: 15000,
  motionOnlyMode: false,
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
    // motionOnlyMode is intentionally NOT restored from storage — it always starts
    // false to prevent accidental clips every session if the user forgot they'd set it.
    return { ...DEFAULT_CONFIG, ...saved, motionOnlyMode: false }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(c: SwingConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(c))
  } catch { /* non-fatal */ }
}
