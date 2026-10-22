import { useState, useRef, forwardRef, useImperativeHandle, useEffect } from 'react'

const FRAME_RATE = 30

const PALETTE = ['#ffffff', '#ef4444', '#f97316', '#facc15', '#22c55e', '#3b82f6', '#a855f7']

interface VideoPlayerHandle {
  play: () => void
  pause: () => void
  stepFrame: (direction: 1 | -1) => void
  isPaused: () => boolean
  reset: () => void
}

interface DragState {
  startX: number
  startY: number
  currentX: number
  currentY: number
}

interface ZoomState {
  scale: number
  originX: number
  originY: number
}

const VideoPlayer = forwardRef<VideoPlayerHandle, { label: string }>(({ label }, ref) => {
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoName, setVideoName] = useState<string>('')
  const [isPaused, setIsPaused] = useState(false)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [zoom, setZoom] = useState<ZoomState | null>(null)
  const [zoomMode, setZoomMode] = useState(false)
  const [drawMode, setDrawMode] = useState(false)
  const [drawColor, setDrawColor] = useState(PALETTE[0])

  const inputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const linesRef = useRef<{ x1: number; y1: number; x2: number; y2: number; color: string }[]>([])
  const drawStartRef = useRef<{ x: number; y: number } | null>(null)

  function redrawCanvas() {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (const l of linesRef.current) {
      strokeLine(ctx, l.x1, l.y1, l.x2, l.y2, l.color)
    }
  }

  function strokeLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string) {
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.stroke()
  }

  useEffect(() => {
    if (!videoUrl) return
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const observer = new ResizeObserver(() => {
      canvas.width = container.offsetWidth
      canvas.height = container.offsetHeight
      redrawCanvas()
    })
    observer.observe(container)
    canvas.width = container.offsetWidth
    canvas.height = container.offsetHeight
    return () => observer.disconnect()
  }, [videoUrl])

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
    setZoom(null)
    setZoomMode(false)
    setDrawMode(false)
  }

  function togglePlay() {
    if (videoRef.current?.paused) play(); else pause()
  }

  // --- Zoom handlers ---
  function getCoordsRelativeToContainer(e: React.MouseEvent): { x: number; y: number } {
    const container = containerRef.current
    if (!container) return { x: 0, y: 0 }
    const rect = container.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function getCoordsRelativeToVideo(e: React.MouseEvent): { x: number; y: number } {
    const video = videoRef.current
    if (!video) return { x: 0, y: 0 }
    const rect = video.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function handleZoomMouseDown(e: React.MouseEvent) {
    const { x, y } = getCoordsRelativeToVideo(e)
    setDrag({ startX: x, startY: y, currentX: x, currentY: y })
  }

  function handleZoomMouseMove(e: React.MouseEvent) {
    if (!drag) return
    const { x, y } = getCoordsRelativeToVideo(e)
    setDrag(prev => prev ? { ...prev, currentX: x, currentY: y } : null)
  }

  function handleZoomMouseUp() {
    if (!drag) return
    const video = videoRef.current
    if (!video) { setDrag(null); return }

    const x1 = Math.min(drag.startX, drag.currentX)
    const y1 = Math.min(drag.startY, drag.currentY)
    const rw = Math.abs(drag.currentX - drag.startX)
    const rh = Math.abs(drag.currentY - drag.startY)

    if (rw > 10 && rh > 10) {
      const scale = Math.min(video.offsetWidth / rw, video.offsetHeight / rh)
      setZoom({ scale, originX: x1 + rw / 2, originY: y1 + rh / 2 })
      setZoomMode(false)
    }
    setDrag(null)
  }

  // --- Draw handlers ---
  function handleDrawMouseDown(e: React.MouseEvent) {
    const { x, y } = getCoordsRelativeToContainer(e)
    drawStartRef.current = { x, y }
  }

  function handleDrawMouseMove(e: React.MouseEvent) {
    if (!drawStartRef.current) return
    const { x, y } = getCoordsRelativeToContainer(e)
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    redrawCanvas()
    strokeLine(ctx, drawStartRef.current.x, drawStartRef.current.y, x, y, drawColor)
  }

  function handleDrawMouseUp(e: React.MouseEvent) {
    if (!drawStartRef.current) return
    const { x, y } = getCoordsRelativeToContainer(e)
    linesRef.current.push({ x1: drawStartRef.current.x, y1: drawStartRef.current.y, x2: x, y2: y, color: drawColor })
    drawStartRef.current = null
    redrawCanvas()
  }

  function clearCanvas() {
    linesRef.current = []
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
  }

  const selectionLeft   = drag ? Math.min(drag.startX, drag.currentX) : 0
  const selectionTop    = drag ? Math.min(drag.startY, drag.currentY) : 0
  const selectionWidth  = drag ? Math.abs(drag.currentX - drag.startX) : 0
  const selectionHeight = drag ? Math.abs(drag.currentY - drag.startY) : 0

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
            <div ref={containerRef} className="relative w-full overflow-hidden rounded-xl">
              <video
                ref={videoRef}
                key={videoUrl}
                src={videoUrl}
                className="w-full block shadow-2xl bg-black"
                style={zoom ? {
                  transform: `scale(${zoom.scale})`,
                  transformOrigin: `${zoom.originX}px ${zoom.originY}px`,
                } : undefined}
                onPlay={() => setIsPaused(false)}
                onPause={() => setIsPaused(true)}
              />

              {/* Annotation canvas */}
              <canvas
                ref={canvasRef}
                className="absolute inset-0 rounded-xl"
                style={{ pointerEvents: drawMode ? 'auto' : 'none', cursor: drawMode ? 'crosshair' : 'default' }}
                onMouseDown={handleDrawMouseDown}
                onMouseMove={handleDrawMouseMove}
                onMouseUp={handleDrawMouseUp}
                onMouseLeave={() => { drawStartRef.current = null }}
              />

              {/* Zoom selection overlay */}
              {zoomMode && !zoom && (
                <div
                  className="absolute inset-0 cursor-crosshair"
                  style={{ pointerEvents: drawMode ? 'none' : 'auto' }}
                  onMouseDown={handleZoomMouseDown}
                  onMouseMove={handleZoomMouseMove}
                  onMouseUp={handleZoomMouseUp}
                  onMouseLeave={() => setDrag(null)}
                />
              )}

              {drag && (
                <div
                  className="absolute pointer-events-none border-2 border-white border-dashed"
                  style={{
                    left: selectionLeft,
                    top: selectionTop,
                    width: selectionWidth,
                    height: selectionHeight,
                    background: 'rgba(255,255,255,0.08)',
                  }}
                />
              )}
            </div>
          </div>

          {/* Color palette — only shown in draw mode */}
          {drawMode && (
            <div className="flex items-center gap-2">
              {PALETTE.map(color => (
                <button
                  key={color}
                  onClick={() => setDrawColor(color)}
                  className="w-7 h-7 rounded-full border-2 transition-transform"
                  style={{
                    background: color,
                    borderColor: drawColor === color ? '#fff' : 'transparent',
                    transform: drawColor === color ? 'scale(1.25)' : 'scale(1)',
                  }}
                />
              ))}
              <button
                onClick={clearCanvas}
                className="ml-2 px-3 py-1 rounded-lg bg-gray-800 hover:bg-gray-700 text-white text-xs font-medium transition-colors"
              >
                Clear
              </button>
            </div>
          )}

          {/* Playback controls */}
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
            {zoom ? (
              <button
                onClick={() => { setZoom(null); setZoomMode(false) }}
                className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium transition-colors"
              >
                Exit Zoom
              </button>
            ) : (
              <button
                onClick={() => { setZoomMode(m => !m); setDrawMode(false) }}
                className={`px-4 py-2 rounded-lg text-white text-sm font-medium transition-colors ${zoomMode ? 'bg-amber-600 hover:bg-amber-500' : 'bg-gray-800 hover:bg-gray-700'}`}
              >
                🔍 Zoom
              </button>
            )}
            <button
              onClick={() => { setDrawMode(m => !m); setZoomMode(false) }}
              className={`px-4 py-2 rounded-lg text-white text-sm font-medium transition-colors ${drawMode ? 'bg-sky-600 hover:bg-sky-500' : 'bg-gray-800 hover:bg-gray-700'}`}
            >
              ✏️ Draw
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