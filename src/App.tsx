import { useState, useRef, forwardRef, useImperativeHandle } from 'react'

const FRAME_RATE = 30

interface VideoPlayerHandle {
  play: () => void
  pause: () => void
  stepFrame: (direction: 1 | -1) => void
  isPaused: () => boolean
  reset: () => void
}

const VideoPlayer = forwardRef<VideoPlayerHandle, { label: string }>(({ label }, ref) => {
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoName, setVideoName] = useState<string>('')
  const [isPaused, setIsPaused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  function stepFrame(direction: 1 | -1) {
    const video = videoRef.current
    if (!video) return
    video.pause()
    setIsPaused(true)
    video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + direction / FRAME_RATE))
  }

  function reset() {
    const video = videoRef.current
    if (!video) return
    video.pause()
    video.currentTime = 0
    setIsPaused(true)
  }

  function play() {
    const video = videoRef.current
    if (!video) return
    video.play()
    setIsPaused(false)
  }

  function pause() {
    const video = videoRef.current
    if (!video) return
    video.pause()
    setIsPaused(true)
  }

  useImperativeHandle(ref, () => ({
    play,
    pause,
    stepFrame,
    isPaused: () => videoRef.current?.paused ?? true,
    reset,
  }))

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (videoUrl) URL.revokeObjectURL(videoUrl)
    setVideoUrl(URL.createObjectURL(file))
    setVideoName(file.name)
    setIsPaused(true)
  }

  function togglePlay() {
    if (videoRef.current?.paused) play(); else pause()
  }

  return (
    <div className="flex flex-col items-center gap-4 flex-1 min-w-0">
      <span className="text-lg font-medium text-gray-300">{label}</span>

      <button
        onClick={() => inputRef.current?.click()}
        className="px-5 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-medium transition-colors text-sm"
      >
        {videoUrl ? 'Select Different Video' : 'Select Video'}
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/*"
        className="hidden"
        onChange={handleFileChange}
      />

      {videoUrl ? (
        <>
          <div className="flex-1 flex items-end w-full">
            <video
              ref={videoRef}
              key={videoUrl}
              src={videoUrl}
              className="w-full rounded-xl shadow-2xl bg-black"
              onPlay={() => setIsPaused(false)}
              onPause={() => setIsPaused(true)}
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={reset}
              className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-white font-mono text-sm transition-colors"
            >
              ⏮
            </button>
            <button
              onClick={() => stepFrame(-1)}
              className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-white font-mono text-sm transition-colors"
            >
              ◀ Frame
            </button>
            <button
              onClick={togglePlay}
              className="px-6 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-medium transition-colors"
            >
              {isPaused ? '▶ Play' : '⏸ Pause'}
            </button>
            <button
              onClick={() => stepFrame(1)}
              className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-white font-mono text-sm transition-colors"
            >
              Frame ▶
            </button>
          </div>

          <p className="text-sm text-gray-400 truncate max-w-full px-2">{videoName}</p>
        </>
      ) : (
        <div className="w-full aspect-video rounded-xl bg-gray-900 flex items-center justify-center">
          <p className="text-gray-600">No video selected</p>
        </div>
      )}
    </div>
  )
})

function App() {
  const player1 = useRef<VideoPlayerHandle>(null)
  const player2 = useRef<VideoPlayerHandle>(null)
  const [syncPaused, setSyncPaused] = useState(true)

  function syncTogglePlay() {
    if (syncPaused) {
      player1.current?.play()
      player2.current?.play()
      setSyncPaused(false)
    } else {
      player1.current?.pause()
      player2.current?.pause()
      setSyncPaused(true)
    }
  }

  function syncStepFrame(direction: 1 | -1) {
    player1.current?.stepFrame(direction)
    player2.current?.stepFrame(direction)
    setSyncPaused(true)
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col items-center p-8 gap-8">
      <h1 className="text-3xl font-semibold tracking-tight">Swing Analyzer</h1>

      <div className="flex flex-col lg:flex-row items-stretch gap-8 w-full max-w-6xl">
        <VideoPlayer ref={player1} label="Video 1" />
        <VideoPlayer ref={player2} label="Video 2" />
      </div>

      <div className="flex flex-col items-center gap-3">
        <span className="text-xs uppercase tracking-widest text-gray-500">Sync Controls</span>
        <div className="flex items-center gap-3">
          <button
            onClick={() => { player1.current?.reset(); player2.current?.reset(); setSyncPaused(true) }}
            className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-white font-mono text-sm transition-colors"
          >
            ⏮
          </button>
          <button
            onClick={() => syncStepFrame(-1)}
            className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-white font-mono text-sm transition-colors"
          >
            ◀ Frame
          </button>
          <button
            onClick={syncTogglePlay}
            className="px-6 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition-colors"
          >
            {syncPaused ? '▶ Play Both' : '⏸ Pause Both'}
          </button>
          <button
            onClick={() => syncStepFrame(1)}
            className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-white font-mono text-sm transition-colors"
          >
            Frame ▶
          </button>
        </div>
      </div>
    </div>
  )
}

export default App