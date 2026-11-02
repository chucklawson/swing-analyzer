import type { SwingConfig } from '../lib/swingConfig.ts'

interface Props {
  audioLevel: number
  config: SwingConfig
  fusionLog: string[]
}

export default function DebugPanel({ audioLevel, config, fusionLog }: Props) {
  const audioThresholdPct = Math.min(100, (1 / config.audioSpikeRatio) * 100 * config.audioSpikeRatio)

  return (
    <div
      className="absolute left-2 bottom-2 right-2 bg-black/80 rounded-xl p-3 text-xs font-mono text-gray-200"
      style={{ zIndex: 4 }}
    >
      {/* Audio bar */}
      <div className="flex items-center gap-2 mb-2">
        <span className="w-14 shrink-0 text-gray-400">Audio</span>
        <div className="relative flex-1 h-3 bg-gray-700 rounded-full overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 bg-green-400 transition-all duration-75"
            style={{ width: `${audioLevel}%` }}
          />
          <div
            className="absolute inset-y-0 w-px bg-yellow-300"
            style={{ left: `${audioThresholdPct}%` }}
          />
        </div>
        <span className="w-10 text-right text-gray-500">{audioLevel}%</span>
      </div>

      {/* Fusion log */}
      <div className="border-t border-gray-700 pt-2">
        <p className="text-gray-500 mb-1">Last decisions:</p>
        {fusionLog.length === 0
          ? <p className="text-gray-600 italic">none yet</p>
          : fusionLog.slice(-8).reverse().map((entry, i) => (
              <p key={i} className={
                entry.startsWith('FIRED')
                  ? 'text-green-400'
                  : entry.includes('cooldown')
                    ? 'text-orange-400'
                    : 'text-red-400'
              }>{entry}</p>
            ))
        }
      </div>
    </div>
  )
}
