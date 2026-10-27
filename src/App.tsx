import { useState, useRef, forwardRef, useImperativeHandle, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ThreeDView } from './ThreeDView'

const FRAME_RATE = 30

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

const PALETTE = ['#ffffff', '#ef4444', '#f97316', '#facc15', '#22c55e', '#3b82f6', '#a855f7']

const FPS_PRESETS = [30, 15, 10, 5, 2, 1]

// Skeleton connections (landmark index pairs) — skips face landmarks
const BODY_CONNECTIONS: [number, number][] = [
  [11,12],[11,13],[13,15],[12,14],[14,16], // shoulders + arms
  [15,17],[15,19],[15,21],[16,18],[16,20],[16,22], // hands
  [11,23],[12,24],[23,24], // torso
  [23,25],[25,27],[24,26],[26,28], // legs
  [27,29],[27,31],[29,31],[28,30],[28,32],[30,32], // feet
]

// --- Angle math ---
function calcAngle(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number }
): number {
  const bax = a.x - b.x, bay = a.y - b.y
  const bcx = c.x - b.x, bcy = c.y - b.y
  const dot = bax * bcx + bay * bcy
  const mag = Math.sqrt(bax ** 2 + bay ** 2) * Math.sqrt(bcx ** 2 + bcy ** 2)
  return mag === 0 ? 0 : Math.round(Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180 / Math.PI)
}

function lineAngleDeg(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.round(Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI)
}

interface PoseAngles {
  lElbow: number; rElbow: number
  lKnee: number;  rKnee: number
  shoulders: number; hips: number; spine: number
}

function extendLineToEdges(
  x1: number, y1: number,
  x2: number, y2: number,
  w: number, h: number
): [number, number, number, number] {
  const dx = x2 - x1, dy = y2 - y1
  if (Math.abs(dx) < 0.5) return [x1, 0, x1, h]
  const yAtLeft  = y1 + (0   - x1) / dx * dy
  const yAtRight = y1 + (w   - x1) / dx * dy
  return [0, yAtLeft, w, yAtRight]
}

function computePoseAngles(lm: { x: number; y: number }[]): PoseAngles {
  const hipMid = { x: (lm[23].x + lm[24].x) / 2, y: (lm[23].y + lm[24].y) / 2 }
  const shoulderMid = { x: (lm[11].x + lm[12].x) / 2, y: (lm[11].y + lm[12].y) / 2 }
  return {
    lElbow:    calcAngle(lm[11], lm[13], lm[15]),
    rElbow:    calcAngle(lm[12], lm[14], lm[16]),
    lKnee:     calcAngle(lm[23], lm[25], lm[27]),
    rKnee:     calcAngle(lm[24], lm[26], lm[28]),
    shoulders: lineAngleDeg(lm[11], lm[12]),
    hips:      lineAngleDeg(lm[23], lm[24]),
    spine:     Math.round(Math.atan2(shoulderMid.x - hipMid.x, hipMid.y - shoulderMid.y) * 180 / Math.PI),
  }
}

// Cached across both player instances so the model only loads once
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedLandmarker: any = null

async function getPoseLandmarker() {
  if (cachedLandmarker) return cachedLandmarker
  const { PoseLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
  )
  cachedLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    },
    runningMode: 'IMAGE',
    numPoses: 1,
  })
  return cachedLandmarker
}

interface VideoPlayerHandle {
  play: () => void
  pause: () => void
  stepFrame: (direction: 1 | -1) => void
  isPaused: () => boolean
  reset: () => void
  setFPS: (fps: number) => void
  getLandmarks: () => { x: number; y: number; z: number }[] | null
}

interface DragState {
  startX: number
  startY: number
  currentX: number
  currentY: number
}

interface DrawStart {
  x: number
  y: number
  color: string
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
  const [hasStartPoint, setHasStartPoint] = useState(false)
  const [playbackFPS, setPlaybackFPS] = useState(FRAME_RATE)
  const [poseStatus, setPoseStatus] = useState<'idle' | 'loading' | 'detected' | 'none'>('idle')
  const poseResultRef = useRef<{ x: number; y: number; z: number }[] | null>(null)
  const poseActiveRef = useRef(false)
  const animFrameRef = useRef<number | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const linesRef = useRef<{ x1: number; y1: number; x2: number; y2: number; color: string }[]>([])
  const drawStartRef = useRef<DrawStart | null>(null)
  const zoomModeRef = useRef(zoomMode)
  const currentZoomRef = useRef(zoom)
  const pinchRef = useRef<{ startDist: number; startScale: number; originX: number; originY: number } | null>(null)

  function redrawCanvas() {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (const l of linesRef.current) {
      strokeLine(ctx, l.x1, l.y1, l.x2, l.y2, l.color)
    }
    const start = drawStartRef.current
    if (start) {
      const size = 10
      ctx.fillStyle = start.color
      ctx.fillRect(start.x - size / 2, start.y - size / 2, size, size)
      ctx.strokeStyle = '#000000'
      ctx.lineWidth = 1.5
      ctx.strokeRect(start.x - size / 2, start.y - size / 2, size, size)
    }
    const pose = poseResultRef.current
    if (pose) {
      const w = canvas.width
      const h = canvas.height
      ctx.strokeStyle = '#00ff88'
      ctx.lineWidth = 2
      for (const [a, b] of BODY_CONNECTIONS) {
        const p1 = pose[a], p2 = pose[b]
        if (!p1 || !p2) continue
        ctx.beginPath()
        ctx.moveTo(p1.x * w, p1.y * h)
        ctx.lineTo(p2.x * w, p2.y * h)
        ctx.stroke()
      }
      ctx.fillStyle = '#ff4444'
      for (const lm of pose) {
        ctx.beginPath()
        ctx.arc(lm.x * w, lm.y * h, 4, 0, Math.PI * 2)
        ctx.fill()
      }

      // Reference lines: shoulder, hip, and spine all extended to canvas edges
      const shoulderMidX = (pose[11].x + pose[12].x) / 2 * w
      const shoulderMidY = (pose[11].y + pose[12].y) / 2 * h
      const hipMidX      = (pose[23].x + pose[24].x) / 2 * w
      const hipMidY      = (pose[23].y + pose[24].y) / 2 * h
      const [sx1, sy1, sx2, sy2] = extendLineToEdges(
        pose[11].x * w, pose[11].y * h,
        pose[12].x * w, pose[12].y * h, w, h
      )
      const [hx1, hy1, hx2, hy2] = extendLineToEdges(
        pose[23].x * w, pose[23].y * h,
        pose[24].x * w, pose[24].y * h, w, h
      )
      const [spx1, spy1, spx2, spy2] = extendLineToEdges(
        hipMidX, hipMidY, shoulderMidX, shoulderMidY, w, h
      )
      ctx.save()
      ctx.setLineDash([10, 5])
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)'
      ctx.lineWidth = 1.5
      // Shoulder line — extended to canvas edges
      ctx.beginPath(); ctx.moveTo(sx1, sy1); ctx.lineTo(sx2, sy2); ctx.stroke()
      // Hip line — extended to canvas edges
      ctx.beginPath(); ctx.moveTo(hx1, hy1); ctx.lineTo(hx2, hy2); ctx.stroke()
      // Spine line — extended, thicker, cyan
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(100, 210, 255, 0.8)'
      ctx.beginPath(); ctx.moveTo(spx1, spy1); ctx.lineTo(spx2, spy2); ctx.stroke()
      ctx.setLineDash([])
      ctx.restore()

      // Joint angle labels + corner stats — outlined text, no background box
      const angles = computePoseAngles(pose)

      function drawOutlinedText(text: string, x: number, y: number, fillColor: string) {
        ctx.strokeStyle = 'rgba(0,0,0,0.85)'
        ctx.lineWidth = 4
        ctx.lineJoin = 'round'
        ctx.strokeText(text, x, y)
        ctx.fillStyle = fillColor
        ctx.fillText(text, x, y)
      }

      ctx.font = 'bold 24px monospace'
      const jointLabels = [
        { angle: angles.lElbow, lm: pose[13], ox: 8,   oy: 0 },
        { angle: angles.rElbow, lm: pose[14], ox: -80, oy: 0 },
        { angle: angles.lKnee,  lm: pose[25], ox: 8,   oy: 0 },
        { angle: angles.rKnee,  lm: pose[26], ox: -80, oy: 0 },
      ]
      for (const { angle, lm, ox, oy } of jointLabels) {
        drawOutlinedText(`${angle}°`, lm.x * w + ox, lm.y * h + oy, '#ffff00')
      }
      // Spine-to-shoulder angle dimension annotation
      {
        // Angle of shoulder line (left→right) and spine line (hip→shoulder midpoint)
        const shoulderDirA = Math.atan2(
          pose[12].y * h - pose[11].y * h,
          pose[12].x * w - pose[11].x * w
        )
        const spineDirA = Math.atan2(shoulderMidY - hipMidY, shoulderMidX - hipMidX)
        // Signed sweep from shoulder→spine, normalized to [-PI, PI]
        let rawSweep = spineDirA - shoulderDirA
        while (rawSweep >  Math.PI) rawSweep -= 2 * Math.PI
        while (rawSweep < -Math.PI) rawSweep += 2 * Math.PI

        // Pick the bisector (from all 4 sectors) pointing most toward upper-left.
        // cos(a)+sin(a) is most negative at -135° (upper-left in canvas coords).
        const b0 = shoulderDirA + rawSweep / 2
        const allB = [b0, b0 + Math.PI, b0 + Math.PI / 2, b0 - Math.PI / 2]
        const bisector = allB.reduce((best, a) =>
          (Math.cos(a) + Math.sin(a)) < (Math.cos(best) + Math.sin(best)) ? a : best
        )

        // Compute the angle of the sector at the chosen bisector.
        // b0 and b0+PI span |rawSweep|; b0±PI/2 span PI-|rawSweep|.
        const diffRaw = ((bisector - b0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
        const bisectorDiff = diffRaw > Math.PI ? 2 * Math.PI - diffRaw : diffRaw
        const sectorAngle = (bisectorDiff < Math.PI / 4 || bisectorDiff > 3 * Math.PI / 4)
          ? Math.abs(rawSweep)
          : Math.PI - Math.abs(rawSweep)
        const dimAngleDeg = Math.round(sectorAngle * 180 / Math.PI)
        const halfSweep = sectorAngle / 2
        const startA = bisector - halfSweep
        const endA   = bisector + halfSweep

        const arcR = 42
        ctx.save()
        ctx.strokeStyle = 'rgba(100, 210, 255, 0.9)'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(shoulderMidX, shoulderMidY, arcR, startA, endA)
        ctx.stroke()
        // Tick marks perpendicular to each arc endpoint
        const tickLen = 7
        for (const a of [startA, endA]) {
          const nx = Math.cos(a + Math.PI / 2), ny = Math.sin(a + Math.PI / 2)
          const px = shoulderMidX + Math.cos(a) * arcR
          const py = shoulderMidY + Math.sin(a) * arcR
          ctx.beginPath()
          ctx.moveTo(px - nx * tickLen / 2, py - ny * tickLen / 2)
          ctx.lineTo(px + nx * tickLen / 2, py + ny * tickLen / 2)
          ctx.stroke()
        }
        ctx.restore()

        const labelR = arcR + 28
        ctx.save()
        ctx.font = 'bold 22px monospace'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        drawOutlinedText(
          `${dimAngleDeg}°`,
          shoulderMidX + Math.cos(bisector) * labelR,
          shoulderMidY + Math.sin(bisector) * labelR,
          '#64d2ff'
        )
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        ctx.restore()
      }

      // Body stats anchored to the torso so they move with the person
      const sign = (n: number) => n > 0 ? `+${n}` : `${n}`
      const statsLines = [
        `Shldr ${sign(angles.shoulders)}°`,
        `Hips  ${sign(angles.hips)}°`,
        `Spine ${sign(angles.spine)}°`,
      ]
      ctx.font = '22px monospace'
      ctx.textAlign = 'right'
      const lh = 30
      const statsStartY = Math.round(h / 3)
      statsLines.forEach((line, i) => drawOutlinedText(line, w - 10, statsStartY + i * lh, '#00ff88'))
      ctx.textAlign = 'left'

    }
  }

  function strokeLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string) {
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.strokeStyle = color
    ctx.lineWidth = 4
    ctx.lineCap = 'round'
    ctx.stroke()
  }

  useEffect(() => { zoomModeRef.current = zoomMode }, [zoomMode])
  useEffect(() => { currentZoomRef.current = zoom }, [zoom])
  useEffect(() => {
    const video = videoRef.current
    if (video) video.playbackRate = playbackFPS / FRAME_RATE
  }, [playbackFPS])

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

    if (!isIOS) return () => observer.disconnect()

    function getTouchDist(t: TouchList) {
      return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    }

    function onPinchStart(e: TouchEvent) {
      if (!zoomModeRef.current || e.touches.length !== 2) return
      e.preventDefault()
      const rect = container.getBoundingClientRect()
      pinchRef.current = {
        startDist: getTouchDist(e.touches),
        startScale: currentZoomRef.current?.scale ?? 1,
        originX: (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
        originY: (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top,
      }
    }

    function onPinchMove(e: TouchEvent) {
      if (!pinchRef.current || e.touches.length !== 2) return
      e.preventDefault()
      const scale = Math.max(1.2, Math.min(10,
        pinchRef.current.startScale * getTouchDist(e.touches) / pinchRef.current.startDist
      ))
      setZoom({ scale, originX: pinchRef.current.originX, originY: pinchRef.current.originY })
    }

    function onPinchEnd() {
      if (pinchRef.current) { setZoomMode(false); pinchRef.current = null }
    }

    container.addEventListener('touchstart', onPinchStart, { passive: false })
    container.addEventListener('touchmove', onPinchMove, { passive: false })
    container.addEventListener('touchend', onPinchEnd)

    return () => {
      observer.disconnect()
      container.removeEventListener('touchstart', onPinchStart)
      container.removeEventListener('touchmove', onPinchMove)
      container.removeEventListener('touchend', onPinchEnd)
    }
  }, [videoUrl])

  function stepFrame(direction: 1 | -1) {
    const video = videoRef.current
    if (!video) return
    video.pause()
    setIsPaused(true)
    video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + direction / FRAME_RATE))
    if (poseActiveRef.current && cachedLandmarker) {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked)
        const result = cachedLandmarker.detect(video)
        if (result.landmarks.length > 0) {
          poseResultRef.current = result.landmarks[0]
          redrawCanvas()
        }
      }
      video.addEventListener('seeked', onSeeked)
    }
  }

  function reset() {
    const video = videoRef.current
    if (!video) return
    video.pause()
    video.currentTime = 0
    setIsPaused(true)
    if (poseActiveRef.current && cachedLandmarker) {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked)
        const result = cachedLandmarker.detect(video)
        if (result.landmarks.length > 0) {
          poseResultRef.current = result.landmarks[0]
          redrawCanvas()
        }
      }
      video.addEventListener('seeked', onSeeked)
    }
  }

  function runPoseLoop() {
    const video = videoRef.current
    if (!video || !poseActiveRef.current || video.paused || video.ended) {
      animFrameRef.current = null
      return
    }
    if (cachedLandmarker) {
      const result = cachedLandmarker.detect(video)
      if (result.landmarks.length > 0) {
        poseResultRef.current = result.landmarks[0]
        redrawCanvas()
      }
    }
    animFrameRef.current = requestAnimationFrame(runPoseLoop)
  }

  function play() {
    const video = videoRef.current
    if (!video) return
    video.playbackRate = playbackFPS / FRAME_RATE
    video.play()
    setIsPaused(false)
    if (poseActiveRef.current && !animFrameRef.current) {
      animFrameRef.current = requestAnimationFrame(runPoseLoop)
    }
  }

  function pause() {
    const video = videoRef.current
    if (!video) return
    video.pause()
    setIsPaused(true)
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = null
    }
  }

  useImperativeHandle(ref, () => ({
    play,
    pause,
    stepFrame,
    isPaused: () => videoRef.current?.paused ?? true,
    reset,
    setFPS: (fps: number) => setPlaybackFPS(fps),
    getLandmarks: () => poseResultRef.current,
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

  // --- Draw handlers (two-click/two-tap: first sets start point, second draws line) ---
  function handleCanvasClick(e: React.MouseEvent) {
    if (!drawMode) return
    const { x, y } = getCoordsRelativeToContainer(e)
    if (!drawStartRef.current) {
      drawStartRef.current = { x, y, color: drawColor }
      setHasStartPoint(true)
      redrawCanvas()
    } else {
      linesRef.current.push({ x1: drawStartRef.current.x, y1: drawStartRef.current.y, x2: x, y2: y, color: drawStartRef.current.color })
      drawStartRef.current = null
      setHasStartPoint(false)
      redrawCanvas()
    }
  }

  function handleCanvasTouchEnd(e: React.TouchEvent) {
    if (!drawMode) return
    e.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const touch = e.changedTouches[0]
    const x = touch.clientX - rect.left
    const y = touch.clientY - rect.top
    if (!drawStartRef.current) {
      drawStartRef.current = { x, y, color: drawColor }
      setHasStartPoint(true)
      redrawCanvas()
    } else {
      linesRef.current.push({ x1: drawStartRef.current.x, y1: drawStartRef.current.y, x2: x, y2: y, color: drawStartRef.current.color })
      drawStartRef.current = null
      setHasStartPoint(false)
      redrawCanvas()
    }
  }

  async function detectPose() {
    const video = videoRef.current
    if (!video) return
    pause()
    setPoseStatus('loading')
    try {
      const landmarker = await getPoseLandmarker()
      const result = landmarker.detect(video)
      if (result.landmarks.length > 0) {
        poseResultRef.current = result.landmarks[0]
        poseActiveRef.current = true
        setPoseStatus('detected')
      } else {
        poseResultRef.current = null
        poseActiveRef.current = false
        setPoseStatus('none')
      }
    } catch (err) {
      console.error('Pose detection failed:', err)
      setPoseStatus('idle')
    }
    redrawCanvas()
  }

  function clearPose() {
    poseActiveRef.current = false
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = null
    }
    poseResultRef.current = null
    setPoseStatus('idle')
    redrawCanvas()
  }

  function clearCanvas() {
    linesRef.current = []
    drawStartRef.current = null
    setHasStartPoint(false)
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
            <div ref={containerRef} className="relative w-full overflow-hidden rounded-xl" style={{ touchAction: (zoomMode && isIOS) ? 'none' : undefined }}>
              <video
                ref={videoRef}
                key={videoUrl}
                src={videoUrl}
                className="w-full block shadow-2xl bg-black"
                playsInline
                preload="metadata"
                style={zoom ? {
                  transform: `scale(${zoom.scale})`,
                  transformOrigin: `${zoom.originX}px ${zoom.originY}px`,
                } : undefined}
                onLoadedMetadata={() => { if (videoRef.current) videoRef.current.currentTime = 0.001 }}
                onPlay={() => setIsPaused(false)}
                onPause={() => setIsPaused(true)}
              />

              {/* Annotation canvas */}
              <canvas
                ref={canvasRef}
                className="absolute inset-0 rounded-xl"
                style={{
                  pointerEvents: drawMode ? 'auto' : 'none',
                  cursor: drawMode ? 'crosshair' : 'default',
                  ...(zoom ? { transform: `scale(${zoom.scale})`, transformOrigin: `${zoom.originX}px ${zoom.originY}px` } : {}),
                }}
                onClick={handleCanvasClick}
                onTouchEnd={handleCanvasTouchEnd}
              />

              {/* Zoom mode prompt — iOS pinch hint */}
              {zoomMode && !zoom && isIOS && (
                <div className="absolute bottom-3 left-3 bg-black/75 text-white text-sm font-medium px-4 py-1.5 rounded-full pointer-events-none z-10 select-none">
                  Pinch to zoom
                </div>
              )}

              {/* Draw mode prompt */}
              {drawMode && (
                <div className="absolute bottom-3 left-3 bg-black/75 text-white text-sm font-medium px-4 py-1.5 rounded-full pointer-events-none z-10 select-none">
                  {hasStartPoint ? 'Select ending point' : 'Select starting point'}
                </div>
              )}

              {/* Zoom selection overlay — desktop rubber-band only, iOS uses pinch */}
              {zoomMode && !zoom && !isIOS && (
                <div
                  className="absolute inset-0 cursor-crosshair"
                  style={{ pointerEvents: drawMode ? 'none' : 'auto' }}
                  onMouseDown={handleZoomMouseDown}
                  onMouseMove={handleZoomMouseMove}
                  onMouseUp={handleZoomMouseUp}
                  onMouseLeave={() => setDrag(null)}
                />
              )}

              {drag && !isIOS && (
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
          <div className="flex items-center gap-2 flex-wrap justify-center">
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

          {/* Tool controls */}
          <div className="flex items-center gap-2 flex-wrap justify-center">
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
              onClick={() => {
                setDrawMode(m => {
                  if (m) { drawStartRef.current = null; setHasStartPoint(false) }
                  return !m
                })
                setZoomMode(false)
              }}
              className={`px-4 py-2 rounded-lg text-white text-sm font-medium transition-colors ${drawMode ? 'bg-sky-600 hover:bg-sky-500' : 'bg-gray-800 hover:bg-gray-700'}`}
            >
              ✏️ Draw
            </button>
            {poseStatus === 'detected' ? (
              <button
                onClick={clearPose}
                className="px-4 py-2 rounded-lg bg-green-700 hover:bg-green-600 text-white text-sm font-medium transition-colors"
              >
                Clear Pose
              </button>
            ) : (
              <button
                onClick={detectPose}
                disabled={poseStatus === 'loading'}
                className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
              >
                {poseStatus === 'loading' ? 'Loading…' : poseStatus === 'none' ? 'No Person' : '🦴 Pose'}
              </button>
            )}
          </div>

          <div className="flex items-center gap-1 flex-wrap justify-center">
            <span className="text-xs text-gray-500 mr-1">Speed:</span>
            {FPS_PRESETS.map(fps => (
              <button
                key={fps}
                onClick={() => setPlaybackFPS(fps)}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                  playbackFPS === fps ? 'bg-sky-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                }`}
              >
                {fps}fps
              </button>
            ))}
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

function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-start justify-center overflow-y-auto p-4">
      <div className="bg-gray-900 rounded-2xl w-full max-w-2xl my-4 shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <h2 className="text-xl font-semibold text-white">Swing Analyzer — User Guide</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl leading-none">✕</button>
        </div>

        <div className="px-6 py-5 flex flex-col gap-6 text-sm text-gray-300">

          {/* Loading Videos */}
          <section>
            <h3 className="text-base font-semibold text-white mb-2">Loading Videos</h3>
            <p>Tap <span className="text-violet-400 font-medium">Select Video</span> on either panel to load a video file from your device. Both panels work independently — you can load different videos in each. Tap <span className="text-violet-400 font-medium">Select Different Video</span> to swap a video out at any time.</p>
          </section>

          {/* Playback */}
          <section>
            <h3 className="text-base font-semibold text-white mb-2">Playback Controls</h3>
            <ul className="flex flex-col gap-1.5 list-none">
              <li><span className="font-mono text-gray-100">⏮</span> — Jump back to the start of the video.</li>
              <li><span className="font-mono text-gray-100">◀ Frame / Frame ▶</span> — Step one frame backward or forward (1/30 sec). Useful for finding the exact moment of impact.</li>
              <li><span className="font-mono text-gray-100">▶ Play / ⏸ Pause</span> — Play or pause the video. Playback speed follows whatever is set in the Speed row.</li>
            </ul>
          </section>

          {/* Speed */}
          <section>
            <h3 className="text-base font-semibold text-white mb-2">Slow Motion Speed</h3>
            <p>Below each player's controls is a <span className="text-sky-400 font-medium">Speed</span> row with presets: <span className="font-mono">30 · 15 · 10 · 5 · 2 · 1 fps</span>. The highlighted button is the active rate. 30 fps is normal speed; 5 fps or lower gives clear slow motion. The <span className="text-emerald-400 font-medium">Both Speed</span> row in Sync Controls sets the same rate on both players simultaneously.</p>
          </section>

          {/* Sync */}
          <section>
            <h3 className="text-base font-semibold text-white mb-2">Sync Controls</h3>
            <p>The controls at the bottom of the page operate both videos together:</p>
            <ul className="flex flex-col gap-1.5 mt-1.5">
              <li><span className="font-mono text-gray-100">⏮</span> — Reset both videos to the start.</li>
              <li><span className="font-mono text-gray-100">◀ Frame / Frame ▶</span> — Step both videos one frame in sync.</li>
              <li><span className="text-emerald-400 font-medium">▶ Play Both / ⏸ Pause Both</span> — Play or pause both videos at once.</li>
            </ul>
          </section>

          {/* Zoom */}
          <section>
            <h3 className="text-base font-semibold text-white mb-2">🔍 Zoom</h3>
            <p className="mb-1.5">Zoom into a region of the video for a closer look.</p>
            <ul className="flex flex-col gap-1.5">
              <li><span className="font-medium text-gray-100">Desktop:</span> Tap <span className="text-amber-400 font-medium">🔍 Zoom</span>, then click and drag a rectangle over the area you want to zoom into.</li>
              <li><span className="font-medium text-gray-100">iPad / iPhone:</span> Tap <span className="text-amber-400 font-medium">🔍 Zoom</span>, then use a two-finger pinch gesture on the video. Spread fingers to zoom in.</li>
              <li>Tap <span className="text-amber-400 font-medium">Exit Zoom</span> to return to normal view.</li>
            </ul>
          </section>

          {/* Draw */}
          <section>
            <h3 className="text-base font-semibold text-white mb-2">✏️ Draw</h3>
            <p className="mb-1.5">Draw reference lines over the video — useful for marking swing plane, alignment, or body angles.</p>
            <ol className="list-decimal list-inside flex flex-col gap-1.5">
              <li>Tap <span className="text-sky-400 font-medium">✏️ Draw</span> to enter draw mode. A prompt appears at the bottom-left of the video.</li>
              <li>Tap or click the <span className="font-medium text-gray-100">starting point</span> of your line. A small colored square appears to confirm the point.</li>
              <li>Tap or click the <span className="font-medium text-gray-100">ending point</span>. The line is drawn.</li>
              <li>Repeat to draw more lines. Each new line starts fresh from step 2.</li>
            </ol>
            <p className="mt-2">Use the <span className="font-medium text-gray-100">color dots</span> below the video to change line color. Tap <span className="font-medium text-gray-100">Clear</span> to remove all lines. Tap <span className="text-sky-400 font-medium">✏️ Draw</span> again to exit draw mode — lines stay on screen.</p>
          </section>

          {/* Pose */}
          <section>
            <h3 className="text-base font-semibold text-white mb-2">🦴 Pose Analysis</h3>
            <p className="mb-1.5">Uses AI to detect the person's body and overlay a skeleton with real-time angle measurements and reference lines.</p>
            <ol className="list-decimal list-inside flex flex-col gap-1.5">
              <li>Pause the video on a frame where the person is clearly visible.</li>
              <li>Tap <span className="font-medium text-gray-100">🦴 Pose</span>. The first time you use it, the AI model downloads (~8 MB) which takes a few seconds. After that it's instant.</li>
              <li>A <span className="text-green-400 font-medium">green skeleton</span> appears with <span className="text-yellow-400 font-medium">yellow angle labels</span> at each elbow and knee.</li>
              <li>Hit Play — the skeleton and all overlays track the person as the video plays. Works best at slow motion speeds.</li>
            </ol>
            <div className="mt-2 bg-gray-800 rounded-lg p-3 flex flex-col gap-1.5">
              <p className="font-medium text-gray-100 mb-1">Body angle readouts (green, right side of frame):</p>
              <p><span className="text-green-400 font-medium">Shldr</span> — tilt of the shoulder line from horizontal. 0° = level.</p>
              <p><span className="text-green-400 font-medium">Hips</span> — tilt of the hip line from horizontal. 0° = level.</p>
              <p><span className="text-green-400 font-medium">Spine</span> — lateral lean of the spine from vertical. 0° = upright.</p>
            </div>
            <div className="mt-2 bg-gray-800 rounded-lg p-3 flex flex-col gap-1.5">
              <p className="font-medium text-gray-100 mb-1">Reference lines (update every frame):</p>
              <p><span className="text-gray-100 font-medium">Shoulder line</span> — white dashed line extended to both edges of the frame through the two shoulder joints.</p>
              <p><span className="text-gray-100 font-medium">Hip line</span> — white dashed line drawn between the two hip joints.</p>
              <p><span className="text-cyan-400 font-medium">Spine line</span> — cyan line extended to both edges of the frame through the midpoint of the hips and midpoint of the shoulders. This is the same axis used to compute the Spine angle readout.</p>
            </div>
            <div className="mt-2 bg-gray-800 rounded-lg p-3">
              <p className="font-medium text-gray-100 mb-1">Spine–Shoulder dimension <span className="text-cyan-400">(cyan arc + °label)</span></p>
              <p>The angle between the spine line and the shoulder line is measured and displayed as a dimension annotation — an arc with tick marks, positioned in the upper-left area of their intersection. This value updates live as the body rotates through the swing.</p>
              <p className="mt-1.5 text-cyan-300 font-medium">Target: 90°. A value of 90° means the spine is perfectly perpendicular to the shoulders, which is the correct address and impact position in the golf swing. Deviation from 90° indicates sway, tilt, or loss of spine angle.</p>
            </div>
            <p className="mt-2">Tap <span className="font-medium text-gray-100">Clear Pose</span> to remove the skeleton and all overlays.</p>
          </section>

          {/* 3D View */}
          <section>
            <h3 className="text-base font-semibold text-white mb-2">▼ 3D Skeleton View</h3>
            <p className="mb-1.5">Combines the pose data from both videos into a single rotatable 3D skeleton. Requires <span className="font-medium text-gray-100">🦴 Pose</span> active on both players — Video 1 as the front view, Video 2 as the side view.</p>
            <ol className="list-decimal list-inside flex flex-col gap-1.5">
              <li>Run <span className="font-medium text-gray-100">🦴 Pose</span> on both Video 1 and Video 2.</li>
              <li>Tap <span className="text-indigo-400 font-medium">▼ Show 3D View</span> in the Sync Controls section.</li>
              <li>A full-screen 3D skeleton appears. Use the <span className="font-medium text-gray-100">rotation slider</span> at the bottom to spin it left or right up to 180° each way.</li>
              <li>Pinch or scroll to zoom. Tap the angle readout to reset rotation to 0°.</li>
            </ol>
            <div className="mt-2 bg-gray-800 rounded-lg p-3 flex flex-col gap-1">
              <p className="font-medium text-gray-100 mb-1">Axis colors:</p>
              <p><span style={{color:'#ff8800'}} className="font-medium">■ Orange</span> — X axis (left / right)</p>
              <p><span style={{color:'#ffff00'}} className="font-medium">■ Yellow</span> — Y axis (up / down)</p>
              <p><span style={{color:'#00ccff'}} className="font-medium">■ Cyan</span> — Z axis (depth, front to back)</p>
            </div>
            <p className="mt-2">Tap <span className="font-medium text-gray-100">✕</span> to close the 3D view. The skeleton continues tracking if the videos are still playing.</p>
          </section>

          {/* Tips */}
          <section className="border-t border-gray-700 pt-4">
            <h3 className="text-base font-semibold text-white mb-2">Tips</h3>
            <ul className="flex flex-col gap-1.5">
              <li>Load the front view in Video 1 and the side view in Video 2 — this gives the most accurate 3D skeleton.</li>
              <li>Use <span className="font-medium text-gray-100">Sync Controls</span> to step both views frame by frame in perfect sync.</li>
              <li>The <span className="text-cyan-400 font-medium">spine–shoulder angle</span> is one of the most important numbers in the golf swing. Watch it at address, top of backswing, and impact — it should stay close to 90° throughout.</li>
              <li>Slow the speed to 2–5 fps before hitting Play with Pose active for the smoothest skeleton tracking.</li>
              <li>The 3D view updates live while the videos play — set both to the same slow motion speed for the best result.</li>
              <li>Draw lines to mark additional reference angles like swing plane or club path, alongside the automatic Pose overlays.</li>
            </ul>
          </section>

        </div>

        <div className="px-6 py-4 border-t border-gray-700">
          <button onClick={onClose} className="w-full py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-medium transition-colors">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function App() {
  const navigate = useNavigate()
  const player1 = useRef<VideoPlayerHandle>(null)
  const player2 = useRef<VideoPlayerHandle>(null)
  const [syncPaused, setSyncPaused] = useState(true)
  const [show3D, setShow3D] = useState(false)
  const [showHelp, setShowHelp] = useState(false)

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
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}

      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate('/')}
          className="w-8 h-8 rounded-full bg-gray-700 hover:bg-gray-600 text-white transition-colors flex items-center justify-center"
          title="Home"
        >
          ⌂
        </button>
        <h1 className="text-3xl font-semibold tracking-tight">Swing Analyzer</h1>
        <button
          onClick={() => setShowHelp(true)}
          className="w-8 h-8 rounded-full bg-gray-700 hover:bg-gray-600 text-white text-sm font-bold transition-colors flex items-center justify-center"
          title="Help"
        >
          ?
        </button>
      </div>

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
        <div className="flex items-center gap-1 flex-wrap justify-center">
          <span className="text-xs text-gray-500 mr-1">Both Speed:</span>
          {FPS_PRESETS.map(fps => (
            <button
              key={fps}
              onClick={() => { player1.current?.setFPS(fps); player2.current?.setFPS(fps) }}
              className="px-2 py-1 rounded text-xs font-medium bg-gray-800 hover:bg-emerald-700 text-gray-300 transition-colors"
            >
              {fps}fps
            </button>
          ))}
        </div>
        <button
          onClick={() => setShow3D(v => !v)}
          className={`px-5 py-2 rounded-lg text-white text-sm font-medium transition-colors ${show3D ? 'bg-indigo-600 hover:bg-indigo-500' : 'bg-gray-800 hover:bg-gray-700'}`}
        >
          {show3D ? '▲ Hide 3D View' : '▼ Show 3D View'}
        </button>
      </div>

      {show3D && (
        <ThreeDView player1={player1} player2={player2} onClose={() => setShow3D(false)} />
      )}
    </div>
  )
}

export default App