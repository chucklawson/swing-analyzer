export interface TraceEntry {
  ts: number
  motionScore: number
  audioLevel: number
  decision?: string
}

const MAX_ENTRIES = 36000  // ~10 min at 1 sample/100ms

export class TraceRecorder {
  private entries: TraceEntry[] = []

  record(entry: TraceEntry) {
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.shift()
  }

  export(): string {
    return JSON.stringify(this.entries)
  }

  slice(fromTs: number, toTs: number): TraceEntry[] {
    return this.entries.filter(e => e.ts >= fromTs && e.ts <= toTs)
  }

  clear() { this.entries = [] }
  length() { return this.entries.length }
}

export function replayFusion(
  entries: TraceEntry[],
  fusion: { feedMotionSpike: (ts: number) => void; feedAudioImpact: (ts: number, level: number) => void },
) {
  for (const e of entries) {
    if (e.decision === 'motion-spike') fusion.feedMotionSpike(e.ts)
    if (e.decision === 'audio-impact') fusion.feedAudioImpact(e.ts, e.audioLevel)
  }
}
