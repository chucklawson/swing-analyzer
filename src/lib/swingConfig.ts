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
  fusionWindowMs: number       // ms after motion spike to still accept a late-arriving motion RAF callback
  audioLookbackMs: number      // how far back to look for motion when audio impact fires
  cooldownMs: number           // ms before fusion can fire again
  motionOnlyMode: boolean      // save clips on motion alone (default off)
  audioOnlyMode: boolean       // save clips on audio alone, no motion check (diagnostic)
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
  audioLookbackMs: 2000,
  cooldownMs: 7000,
  motionOnlyMode: false,
  audioOnlyMode: false,
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
    return { ...DEFAULT_CONFIG, ...saved, motionOnlyMode: false, audioOnlyMode: false }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(c: SwingConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(c))
  } catch { /* non-fatal */ }
}
