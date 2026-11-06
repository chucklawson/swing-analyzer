import { useState, useRef, forwardRef, useImperativeHandle, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ThreeDView } from './ThreeDView'

const FRAME_RATE = 30

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hasOpfs = 'storage' in navigator && typeof (navigator.storage as any).getDirectory === 'function'

function formatClipName(name: string): string {
  const m = name.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_(\d+)_([FD])(?:_\d+)?\.(mp4|webm)$/)
  if (!m) return name
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const view = m[8] === 'F' ? 'Front' : 'Down-the-line'
  return `${months[parseInt(m[2])-1]} ${parseInt(m[3])} · Clip ${m[7]} · ${view} · ${m[4]}:${m[5]}:${m[6]}`
}

function parseImpactMs(name: string): number | null {
  const parts = name.replace(/\.(mp4|webm)$/, '').split('_')
  if (parts.length !== 5) return null
  const ms = parseInt(parts[4], 10)
  return isNaN(ms) ? null : ms
}

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
  lWristIndex: number; lWristThumb: number
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
    lElbow:      calcAngle(lm[11], lm[13], lm[15]),
    rElbow:      calcAngle(lm[12], lm[14], lm[16]),
    lKnee:       calcAngle(lm[23], lm[25], lm[27]),
    rKnee:       calcAngle(lm[24], lm[26], lm[28]),
    shoulders:   lineAngleDeg(lm[11], lm[12]),
    hips:        lineAngleDeg(lm[23], lm[24]),
    spine:       Math.round(Math.atan2(shoulderMid.x - hipMid.x, hipMid.y - shoulderMid.y) * 180 / Math.PI),
    lWristIndex: calcAngle(lm[19], lm[15], lm[13]),
    lWristThumb: calcAngle(lm[21], lm[15], lm[13]),
  }
}

// Cached across both player instances so the model only loads once
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedLandmarker: any = null   // reset on each module load — never persists across page reloads

async function getPoseLandmarker() {
  if (cachedLandmarker) return cachedLandmarker
  const { PoseLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm'
  )
  cachedLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.3,
    minPosePresenceConfidence: 0.3,
    minTrackingConfidence: 0.3,
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
  setMuted: (muted: boolean) => void
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
  const [impactMs, setImpactMs] = useState<number | null>(null)
  const [isPaused, setIsPaused] = useState(false)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [zoom, setZoom] = useState<ZoomState | null>(null)
  const [zoomMode, setZoomMode] = useState(false)
  const [drawMode, setDrawMode] = useState(false)
  const [drawColor, setDrawColor] = useState(PALETTE[0])
  const [hasStartPoint, setHasStartPoint] = useState(false)
  const [hLineMode, setHLineMode] = useState(false)
  const [vLineMode, setVLineMode] = useState(false)
  const [playbackFPS, setPlaybackFPS] = useState(FRAME_RATE)
  const [poseStatus, setPoseStatus] = useState<'idle' | 'loading' | 'detected' | 'none'>('idle')
  const [showWristAngles, setShowWristAngles] = useState(false)
  const showWristAnglesRef = useRef(false)
  const [showJointAngles, setShowJointAngles] = useState(false)
  const showJointAnglesRef = useRef(false)
  const [showArmLines, setShowArmLines] = useState(false)
  const showArmLinesRef = useRef(false)
  const [showHipLine, setShowHipLine] = useState(false)
  const showHipLineRef = useRef(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [showClips, setShowClips] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [opfsClips, setOpfsClips] = useState<{ name: string; handle: any }[]>([])
  const [clipsLoading, setClipsLoading] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedClips, setSelectedClips] = useState<Set<string>>(new Set())
  const [exportAllFlash, setExportAllFlash] = useState<'idle' | 'working' | 'done'>('idle')
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
  const drawModeRef   = useRef(drawMode)
  const hLineModeRef  = useRef(false)
  const vLineModeRef  = useRef(false)
  const pinchRef = useRef<{ startDist: number; startScale: number; originX: number; originY: number } | null>(null)
  const panStartRef = useRef<{ startX: number; startY: number; startOriginX: number; startOriginY: number } | null>(null)

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
        ctx.arc(lm.x * w, lm.y * h, 2, 0, Math.PI * 2)
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
      // Shoulder line — always shown
      ctx.beginPath(); ctx.moveTo(sx1, sy1); ctx.lineTo(sx2, sy2); ctx.stroke()
      // Hip line — toggled via checkbox
      if (showHipLineRef.current) {
        ctx.beginPath(); ctx.moveTo(hx1, hy1); ctx.lineTo(hx2, hy2); ctx.stroke()
      }
      // Spine line — always shown, thicker, cyan
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(100, 210, 255, 0.8)'
      ctx.beginPath(); ctx.moveTo(spx1, spy1); ctx.lineTo(spx2, spy2); ctx.stroke()
      ctx.setLineDash([])
      ctx.restore()

      // Arm lines — only when Wrist ° is active and checkbox enabled
      if (showWristAnglesRef.current && showArmLinesRef.current) {
        const lElbowPt = pose[13], lWristPt = pose[15], lIndexPt = pose[19]
        if (lElbowPt && lWristPt && lIndexPt) {
          const [alx1, aly1, alx2, aly2] = extendLineToEdges(
            lElbowPt.x * w, lElbowPt.y * h, lWristPt.x * w, lWristPt.y * h, w, h
          )
          const [hlx1, hly1, hlx2, hly2] = extendLineToEdges(
            lWristPt.x * w, lWristPt.y * h, lIndexPt.x * w, lIndexPt.y * h, w, h
          )
          ctx.save()
          ctx.setLineDash([10, 5])
          ctx.lineWidth = 1.5
          // Forearm line (elbow→wrist) — white
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)'
          ctx.beginPath(); ctx.moveTo(alx1, aly1); ctx.lineTo(alx2, aly2); ctx.stroke()
          // Hand line (wrist→index finger) — orange
          ctx.strokeStyle = 'rgba(251, 146, 60, 0.85)'
          ctx.beginPath(); ctx.moveTo(hlx1, hly1); ctx.lineTo(hlx2, hly2); ctx.stroke()
          ctx.setLineDash([])
          ctx.restore()
        }
      }

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

      if (showJointAnglesRef.current) {
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
      }

      // Wrist angles — left hand only, toggled via showWristAnglesRef
      if (showWristAnglesRef.current) {
        const lWrist = pose[15], lElbow = pose[13], lIndex = pose[19]
        if (lWrist && lElbow && lIndex) {
          const wx = lWrist.x * w, wy = lWrist.y * h
          // Index angle: elbow→wrist→index (lm 19→15→13)
          ctx.strokeStyle = 'rgba(251,146,60,0.9)'
          ctx.lineWidth = 3
          ctx.beginPath()
          ctx.moveTo(lElbow.x * w, lElbow.y * h)
          ctx.lineTo(wx, wy)
          ctx.lineTo(lIndex.x * w, lIndex.y * h)
          ctx.stroke()
          ctx.font = 'bold 22px monospace'
          drawOutlinedText(`${angles.lWristIndex}°`, wx + 8, wy - 14, '#fb923c')
        }
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
  useEffect(() => { drawModeRef.current = drawMode }, [drawMode])
  useEffect(() => { hLineModeRef.current = hLineMode }, [hLineMode])
  useEffect(() => { vLineModeRef.current = vLineMode }, [vLineMode])
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

    function onPanTouchStart(e: TouchEvent) {
      if (!currentZoomRef.current || drawModeRef.current || e.touches.length !== 1) return
      if ((e.target as Element).closest('button')) return
      e.preventDefault()
      panStartRef.current = {
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        startOriginX: currentZoomRef.current.originX,
        startOriginY: currentZoomRef.current.originY,
      }
    }

    function onPanTouchMove(e: TouchEvent) {
      if (!panStartRef.current || !currentZoomRef.current || e.touches.length !== 1) return
      e.preventDefault()
      const z = currentZoomRef.current
      const w = container.offsetWidth
      const h = container.offsetHeight
      const dx = e.touches[0].clientX - panStartRef.current.startX
      const dy = e.touches[0].clientY - panStartRef.current.startY
      const divisor = z.scale - 1
      const newOriginX = Math.max(0, Math.min(w, panStartRef.current.startOriginX - dx / divisor))
      const newOriginY = Math.max(0, Math.min(h, panStartRef.current.startOriginY - dy / divisor))
      setZoom({ scale: z.scale, originX: newOriginX, originY: newOriginY })
    }

    function onPanTouchEnd() {
      panStartRef.current = null
    }

    container.addEventListener('touchstart', onPinchStart, { passive: false })
    container.addEventListener('touchmove', onPinchMove, { passive: false })
    container.addEventListener('touchend', onPinchEnd)
    container.addEventListener('touchstart', onPanTouchStart, { passive: false })
    container.addEventListener('touchmove', onPanTouchMove, { passive: false })
    container.addEventListener('touchend', onPanTouchEnd)
    container.addEventListener('touchcancel', onPanTouchEnd)

    return () => {
      observer.disconnect()
      container.removeEventListener('touchstart', onPinchStart)
      container.removeEventListener('touchmove', onPinchMove)
      container.removeEventListener('touchend', onPinchEnd)
      container.removeEventListener('touchstart', onPanTouchStart)
      container.removeEventListener('touchmove', onPanTouchMove)
      container.removeEventListener('touchend', onPanTouchEnd)
      container.removeEventListener('touchcancel', onPanTouchEnd)
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
        const result = cachedLandmarker.detectForVideo(video, performance.now())
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
        const result = cachedLandmarker.detectForVideo(video, performance.now())
        if (result.landmarks.length > 0) {
          poseResultRef.current = result.landmarks[0]
          redrawCanvas()
        }
      }
      video.addEventListener('seeked', onSeeked)
    }
  }

  function seekToImpact() {
    const video = videoRef.current
    if (!video || impactMs === null) return
    const target = video.duration - impactMs / 1000
    if (isNaN(target) || target < 0) return
    video.pause()
    setIsPaused(true)
    video.currentTime = target
    if (poseActiveRef.current && cachedLandmarker) {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked)
        const result = cachedLandmarker.detectForVideo(video, performance.now())
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
      const result = cachedLandmarker.detectForVideo(video, performance.now())
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
    if (video.ended) video.currentTime = 0
    video.playbackRate = playbackFPS / FRAME_RATE
    video.play().catch((err: unknown) => { if ((err as Error)?.name !== 'AbortError') console.warn('video.play rejected:', err) })
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
    setMuted: (muted: boolean) => { if (videoRef.current) videoRef.current.muted = muted },
    getLandmarks: () => poseResultRef.current,
  }))

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (videoUrl) URL.revokeObjectURL(videoUrl)
    setVideoUrl(URL.createObjectURL(file))
    setVideoName(file.name)
    setImpactMs(parseImpactMs(file.name))
    setIsPaused(true)
    setZoom(null)
    setZoomMode(false)
    setDrawMode(false)
    setHLineMode(false)
    setVLineMode(false)
  }

  async function openClipBrowser() {
    setShowClips(true)
    setClipsLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const root = await (navigator.storage as any).getDirectory()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clips: { name: string; handle: any }[] = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const [name, handle] of (root as any).entries()) {
        if (handle.kind === 'file' && /^\d{8}_\d{6}_\d+_[FD](?:_\d+)?\.(mp4|webm)$/.test(name)) {
          clips.push({ name, handle })
        }
      }
      clips.sort((a, b) => b.name.localeCompare(a.name))
      setOpfsClips(clips)
    } catch { setOpfsClips([]) }
    setClipsLoading(false)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function loadOpfsClip(handle: any) {
    const file = await handle.getFile()
    if (videoUrl) URL.revokeObjectURL(videoUrl)
    setVideoUrl(URL.createObjectURL(file))
    setVideoName(file.name)
    setImpactMs(parseImpactMs(file.name))
    setIsPaused(true)
    setZoom(null)
    setZoomMode(false)
    setDrawMode(false)
    setHLineMode(false)
    setVLineMode(false)
    setShowClips(false)
  }

  async function deleteOpfsClip(name: string) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const root = await (navigator.storage as any).getDirectory()
      await root.removeEntry(name)
      setOpfsClips(prev => prev.filter(c => c.name !== name))
    } catch { /* non-fatal */ }
  }

  function closeClipBrowser() {
    setShowClips(false)
    setSelectMode(false)
    setSelectedClips(new Set())
  }

  function toggleSelectMode() {
    setSelectMode(m => !m)
    setSelectedClips(new Set())
  }

  function toggleClipSelection(name: string) {
    setSelectedClips(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  }

  function toggleSelectAll() {
    setSelectedClips(
      selectedClips.size === opfsClips.length
        ? new Set()
        : new Set(opfsClips.map(c => c.name))
    )
  }

  async function deleteSelectedClips() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const root = await (navigator.storage as any).getDirectory()
      for (const name of selectedClips) {
        try { await root.removeEntry(name) } catch { /* non-fatal */ }
      }
      setOpfsClips(prev => prev.filter(c => !selectedClips.has(c.name)))
      setSelectedClips(new Set())
      setSelectMode(false)
    } catch { /* non-fatal */ }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function exportOpfsClip(handle: any, name: string) {
    const raw = await handle.getFile()
    const file = new File([raw], name, { type: raw.type || 'video/mp4' })
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return } catch { /* cancelled */ }
    }
    // Fallback: anchor download
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url; a.download = name
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  async function exportAllOpfsClips() {
    if (opfsClips.length === 0) return
    setExportAllFlash('working')
    try {
      const files = await Promise.all(opfsClips.map(async clip => {
        const raw = await clip.handle.getFile()
        return new File([raw], clip.name, { type: raw.type || 'video/mp4' })
      }))
      if (navigator.share && navigator.canShare?.({ files })) {
        try { await navigator.share({ files }) } catch { /* cancelled */ }
      } else {
        // Fallback: sequential anchor downloads
        for (const file of files) {
          const url = URL.createObjectURL(file)
          const a = document.createElement('a')
          a.href = url; a.download = file.name
          document.body.appendChild(a); a.click(); document.body.removeChild(a)
          setTimeout(() => URL.revokeObjectURL(url), 2000)
          await new Promise(r => setTimeout(r, 500))
        }
      }
      setExportAllFlash('done')
      setTimeout(() => setExportAllFlash('idle'), 2000)
    } catch {
      setExportAllFlash('idle')
    }
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
  function placeHLine(x: number, y: number) {
    const canvas = canvasRef.current
    if (!canvas) return
    const half = canvas.width / 4   // ±quarter width → total = half viewport width
    linesRef.current.push({ x1: x - half, y1: y, x2: x + half, y2: y, color: drawColor })
    redrawCanvas()
  }

  function placeVLine(x: number, y: number) {
    const canvas = canvasRef.current
    if (!canvas) return
    const half = canvas.height / 4   // ±quarter height → total = half viewport height
    linesRef.current.push({ x1: x, y1: y - half, x2: x, y2: y + half, color: drawColor })
    redrawCanvas()
  }

  function handleCanvasClick(e: React.MouseEvent) {
    const { x, y } = getCoordsRelativeToContainer(e)
    if (hLineMode) { placeHLine(x, y); return }
    if (vLineMode) { placeVLine(x, y); return }
    if (!drawMode) return
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
    if (!drawMode && !hLineMode && !vLineMode) return
    e.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const touch = e.changedTouches[0]
    const x = touch.clientX - rect.left
    const y = touch.clientY - rect.top
    if (hLineMode) { placeHLine(x, y); return }
    if (vLineMode) { placeVLine(x, y); return }
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
      const result = landmarker.detectForVideo(video, performance.now())
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
    <div className={fullscreen
      ? 'fixed inset-0 z-40 bg-gray-950 flex flex-col items-center gap-4 overflow-y-auto p-4'
      : 'flex flex-col items-center gap-4 flex-1 min-w-0'
    }>
      <span className="text-lg font-medium text-gray-300">{label}</span>

      <div className="flex gap-2">
        <button
          onClick={() => inputRef.current?.click()}
          className="px-5 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-medium transition-colors text-sm"
        >
          {videoUrl ? 'Change Video' : 'Select Video'}
        </button>
        {hasOpfs && (
          <button
            onClick={openClipBrowser}
            className="px-5 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-white font-medium transition-colors text-sm"
          >
            My Clips
          </button>
        )}
      </div>

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
            <div ref={containerRef} className="relative w-full overflow-hidden rounded-xl" style={{ touchAction: ((zoomMode && isIOS) || !!zoom) ? 'none' : undefined }}>
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
                  pointerEvents: (drawMode || hLineMode || vLineMode) ? 'auto' : 'none',
                  cursor: (drawMode || hLineMode || vLineMode) ? 'crosshair' : 'default',
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
              {hLineMode && (
                <div className="absolute bottom-3 left-3 bg-black/75 text-white text-sm font-medium px-4 py-1.5 rounded-full pointer-events-none z-10 select-none">
                  Tap to place horizontal line
                </div>
              )}
              {vLineMode && (
                <div className="absolute bottom-3 left-3 bg-black/75 text-white text-sm font-medium px-4 py-1.5 rounded-full pointer-events-none z-10 select-none">
                  Tap to place vertical line
                </div>
              )}

              {/* Fullscreen toggle — bottom-right corner */}
              <button
                onClick={() => setFullscreen(f => !f)}
                className="absolute bottom-3 right-3 w-8 h-8 flex items-center justify-center bg-black/60 hover:bg-black/80 rounded-md z-20 transition-colors"
                title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              >
                {fullscreen ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
                    <path d="M9 9H3V7h4V3h2v6zm6 0V3h2v4h4v2h-6zm-6 6H3v-2h6v6H7v-4zm8 4v-6h6v2h-4v4h-2z"/>
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
                    <path d="M3 3h6v2H5v4H3V3zm12 0h6v6h-2V5h-4V3zM3 15h2v4h4v2H3v-6zm16 4h-4v2h6v-6h-2v4z"/>
                  </svg>
                )}
              </button>

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

              {/* Pan overlay — drag to scroll when zoomed */}
              {zoom && !drawMode && !zoomMode && !isIOS && (
                <div
                  className="absolute inset-0 cursor-grab active:cursor-grabbing"
                  onMouseDown={(e) => {
                    panStartRef.current = {
                      startX: e.clientX, startY: e.clientY,
                      startOriginX: zoom.originX, startOriginY: zoom.originY,
                    }
                  }}
                  onMouseMove={(e) => {
                    if (!panStartRef.current) return
                    const s = zoom.scale
                    const w = containerRef.current?.offsetWidth ?? 1
                    const h = containerRef.current?.offsetHeight ?? 1
                    const dx = e.clientX - panStartRef.current.startX
                    const dy = e.clientY - panStartRef.current.startY
                    const divisor = s - 1
                    setZoom({
                      scale: s,
                      originX: Math.max(0, Math.min(w, panStartRef.current.startOriginX - dx / divisor)),
                      originY: Math.max(0, Math.min(h, panStartRef.current.startOriginY - dy / divisor)),
                    })
                  }}
                  onMouseUp={() => { panStartRef.current = null }}
                  onMouseLeave={() => { panStartRef.current = null }}
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

          {/* Color palette — shown in draw, H-line, or V-line mode */}
          {(drawMode || hLineMode || vLineMode) && (
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
            {impactMs !== null && (
              <button
                onClick={seekToImpact}
                className="px-4 py-2 rounded-lg bg-orange-700 hover:bg-orange-600 text-white font-mono text-sm transition-colors"
              >
                Impact
              </button>
            )}
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
                onClick={() => { setZoomMode(m => !m); setDrawMode(false); setHLineMode(false); setVLineMode(false); drawStartRef.current = null; setHasStartPoint(false) }}
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
                setHLineMode(false)
                setVLineMode(false)
              }}
              className={`px-4 py-2 rounded-lg text-white text-sm font-medium transition-colors ${drawMode ? 'bg-sky-600 hover:bg-sky-500' : 'bg-gray-800 hover:bg-gray-700'}`}
            >
              ✏️ Draw
            </button>
            <button
              onClick={() => { setHLineMode(m => !m); setVLineMode(false); setDrawMode(false); setZoomMode(false); drawStartRef.current = null; setHasStartPoint(false) }}
              className={`px-4 py-2 rounded-lg text-white text-sm font-medium transition-colors ${hLineMode ? 'bg-sky-600 hover:bg-sky-500' : 'bg-gray-800 hover:bg-gray-700'}`}
            >
              — H Line
            </button>
            <button
              onClick={() => { setVLineMode(m => !m); setHLineMode(false); setDrawMode(false); setZoomMode(false); drawStartRef.current = null; setHasStartPoint(false) }}
              className={`px-4 py-2 rounded-lg text-white text-sm font-medium transition-colors ${vLineMode ? 'bg-sky-600 hover:bg-sky-500' : 'bg-gray-800 hover:bg-gray-700'}`}
            >
              | V Line
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
            {poseStatus === 'detected' && (
              <button
                onClick={() => {
                  const v = !showWristAngles
                  setShowWristAngles(v)
                  showWristAnglesRef.current = v
                  redrawCanvas()
                }}
                className={`px-4 py-2 rounded-lg text-white text-sm font-medium transition-colors ${showWristAngles ? 'bg-orange-700 hover:bg-orange-600' : 'bg-gray-800 hover:bg-gray-700'}`}
              >
                Wrist °
              </button>
            )}
          </div>
          {poseStatus === 'detected' && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 justify-center">
              <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer select-none">
                <input type="checkbox" checked={showHipLine} onChange={e => { const v = e.target.checked; setShowHipLine(v); showHipLineRef.current = v; redrawCanvas() }} className="accent-white w-4 h-4" />
                Hip line
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer select-none">
                <input type="checkbox" checked={showJointAngles} onChange={e => { const v = e.target.checked; setShowJointAngles(v); showJointAnglesRef.current = v; redrawCanvas() }} className="accent-yellow-400 w-4 h-4" />
                Joint angles
              </label>
            </div>
          )}
          {poseStatus === 'detected' && showWristAngles && (
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer select-none">
              <input type="checkbox" checked={showArmLines} onChange={e => { const v = e.target.checked; setShowArmLines(v); showArmLinesRef.current = v; redrawCanvas() }} className="accent-orange-400 w-4 h-4" />
              Arm lines
            </label>
          )}
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

      {showClips && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-end justify-center"
          onClick={closeClipBrowser}
        >
          <div
            className="bg-gray-900 rounded-t-2xl w-full max-w-lg flex flex-col"
            style={{ maxHeight: '70vh' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700 shrink-0">
              {selectMode ? (
                <>
                  <span className="text-white font-medium">{selectedClips.size} selected</span>
                  <div className="flex items-center gap-3">
                    <button onClick={toggleSelectAll} className="text-sm text-blue-400 hover:text-blue-300 transition-colors">
                      {selectedClips.size === opfsClips.length ? 'Deselect All' : 'Select All'}
                    </button>
                    {selectedClips.size > 0 && (
                      <button onClick={deleteSelectedClips} className="px-3 py-1 rounded-lg bg-red-700 hover:bg-red-600 text-white text-sm font-medium transition-colors">
                        Delete ({selectedClips.size})
                      </button>
                    )}
                    <button onClick={toggleSelectMode} className="text-gray-400 hover:text-white text-sm transition-colors">Done</button>
                  </div>
                </>
              ) : (
                <>
                  <h3 className="text-lg font-semibold text-white">Saved Clips</h3>
                  <div className="flex items-center gap-3">
                    {opfsClips.length > 0 && (
                      <>
                        <button
                          onClick={exportAllOpfsClips}
                          disabled={exportAllFlash === 'working'}
                          className={`px-3 py-1 rounded-lg text-sm font-medium transition-colors disabled:cursor-default ${
                            exportAllFlash === 'done'    ? 'bg-green-600 text-white' :
                            exportAllFlash === 'working' ? 'bg-blue-800 text-blue-300' :
                            'bg-blue-700 hover:bg-blue-600 text-white'
                          }`}
                        >
                          {exportAllFlash === 'done' ? '✓ Exported' : exportAllFlash === 'working' ? 'Exporting…' : 'Export All'}
                        </button>
                        <button onClick={toggleSelectMode} className="px-3 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium transition-colors">Select</button>
                      </>
                    )}
                    <button onClick={closeClipBrowser} className="text-gray-400 hover:text-white text-2xl leading-none">✕</button>
                  </div>
                </>
              )}
            </div>

            {/* Clip list */}
            <div className="overflow-y-auto flex flex-col gap-2 p-4 pb-8">
              {clipsLoading ? (
                <p className="text-gray-400 text-center py-8">Loading…</p>
              ) : opfsClips.length === 0 ? (
                <p className="text-gray-500 text-center py-8">No saved clips yet</p>
              ) : opfsClips.map(clip => (
                selectMode ? (
                  <button
                    key={clip.name}
                    onClick={() => toggleClipSelection(clip.name)}
                    className="w-full flex items-center gap-3 bg-gray-800 rounded-lg px-4 py-3 transition-colors"
                  >
                    <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${selectedClips.has(clip.name) ? 'bg-blue-500 border-blue-500' : 'border-gray-500'}`}>
                      {selectedClips.has(clip.name) && (
                        <svg width="12" height="10" viewBox="0 0 12 10" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="1,5 4,8 11,1"/>
                        </svg>
                      )}
                    </div>
                    <div className="flex-1 text-left">
                      <span className="text-white font-medium">{formatClipName(clip.name)}</span>
                      <span className="text-gray-500 text-xs block mt-0.5">{clip.name}</span>
                    </div>
                  </button>
                ) : (
                  <div key={clip.name} className="flex items-center gap-2 bg-gray-800 rounded-lg px-4 py-3">
                    <button className="flex-1 text-left" onClick={() => loadOpfsClip(clip.handle)}>
                      <span className="text-white font-medium">{formatClipName(clip.name)}</span>
                      <span className="text-gray-500 text-xs block mt-0.5">{clip.name}</span>
                    </button>
                    <button onClick={() => exportOpfsClip(clip.handle, clip.name)} className="text-gray-600 hover:text-blue-400 text-lg leading-none px-1 transition-colors" title="Save to Files">⬇</button>
                    <button onClick={() => deleteOpfsClip(clip.name)} className="text-gray-600 hover:text-red-400 text-lg leading-none px-1 transition-colors" title="Delete">🗑</button>
                  </div>
                )
              ))}
            </div>
          </div>
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
            <p className="mb-1.5">Tap <span className="text-violet-400 font-medium">Select Video</span> on either panel to load a video file from your device. Both panels work independently — you can load different videos in each. Tap <span className="text-violet-400 font-medium">Change Video</span> to swap a video out at any time.</p>
            <p>Tap <span className="font-medium text-gray-100">My Clips</span> to browse clips saved by the Create Videos screen. From the clip browser you can load, export, or delete individual clips, or use <span className="font-medium text-gray-100">Select</span> to export or delete multiple clips at once.</p>
          </section>

          {/* Playback */}
          <section>
            <h3 className="text-base font-semibold text-white mb-2">Playback Controls</h3>
            <ul className="flex flex-col gap-1.5 list-none">
              <li><span className="font-mono text-orange-400">Impact</span> — Jump directly to the moment of ball impact. Appears only on clips recorded by the app (the impact time is embedded in the filename). Great for quickly comparing impact position across swings.</li>
              <li><span className="font-mono text-gray-100">⏮</span> — Jump back to the start of the video.</li>
              <li><span className="font-mono text-gray-100">◀ Frame / Frame ▶</span> — Step one frame backward or forward (1/30 sec). Useful for finding the exact moment of impact.</li>
              <li><span className="font-mono text-gray-100">▶ Play / ⏸ Pause</span> — Play or pause the video. Playback speed follows whatever is set in the Speed row.</li>
              <li><span className="font-medium text-gray-100">⛶ Fullscreen icon</span> (bottom-right corner of the video) — Expands the player to fill the entire screen. Tap it again to return to the normal two-panel view.</li>
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

          {/* H Line / V Line */}
          <section>
            <h3 className="text-base font-semibold text-white mb-2">— H Line &amp; | V Line</h3>
            <p className="mb-1.5">Drop a perfectly horizontal or vertical reference line through any point on the video — useful for checking address posture, shoulder level, or ball position.</p>
            <ul className="flex flex-col gap-1.5">
              <li>Tap <span className="text-sky-400 font-medium">— H Line</span> then tap anywhere on the video. A full-width horizontal line is drawn through that point.</li>
              <li>Tap <span className="text-sky-400 font-medium">| V Line</span> then tap anywhere on the video. A full-height vertical line is drawn through that point.</li>
              <li>Each tap replaces the previous H or V line — only one of each is shown at a time.</li>
              <li>Lines persist when you exit the mode. Use <span className="font-medium text-gray-100">Clear</span> (in Draw mode) to remove all annotation lines including H and V lines.</li>
            </ul>
          </section>

          {/* Pose */}
          <section>
            <h3 className="text-base font-semibold text-white mb-2">🦴 Pose Analysis</h3>
            <p className="mb-1.5">Uses AI to detect the person's body and overlay a skeleton with real-time angle measurements and reference lines.</p>
            <ol className="list-decimal list-inside flex flex-col gap-1.5">
              <li>Pause the video on a frame where the person is clearly visible.</li>
              <li>Tap <span className="font-medium text-gray-100">🦴 Pose</span>. The first time you use it, the AI model downloads (~8 MB) which takes a few seconds. After that it's instant.</li>
              <li>A <span className="text-green-400 font-medium">green skeleton</span> appears with reference lines and body angle readouts. Check <span className="text-yellow-400 font-medium">Show joint angles</span> to also display elbow and knee angles in yellow.</li>
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
            <div className="mt-2 bg-gray-800 rounded-lg p-3 flex flex-col gap-1.5">
              <p className="font-medium text-gray-100 mb-1">Wrist angles <span className="text-orange-400">(left hand only)</span></p>
              <p>After Pose is detected, tap <span className="text-orange-400 font-medium">Wrist °</span> to overlay left-hand wrist angle lines with angle readouts.</p>
              <p><span className="text-orange-400 font-medium">Orange line + °</span> — angle at the left wrist formed by the forearm and the line to the left index finger knuckle. Measures wrist cock / bow.</p>
              <p className="mt-1">Check <span className="font-medium text-gray-100">Arm lines</span> (appears below the controls when Wrist ° is active) to also draw the full forearm and hand segments used to compute the angle.</p>
              <p className="mt-1 text-gray-400">The angle updates live as the video plays. Tap <span className="text-orange-400 font-medium">Wrist °</span> again to hide the overlay.</p>
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
              <li>Use <span className="text-orange-400 font-medium">Wrist °</span> at the top of the backswing and at impact to check left-wrist angle — a flat or bowed wrist at impact is associated with a square clubface.</li>
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
      // iOS only allows one unmuted video at a time. Mute both first so they
      // can play simultaneously; unmute when paused (individual play is unaffected).
      player1.current?.setMuted(true)
      player2.current?.setMuted(true)
      player1.current?.play()
      player2.current?.play()
      setSyncPaused(false)
    } else {
      player1.current?.pause()
      player2.current?.pause()
      player1.current?.setMuted(false)
      player2.current?.setMuted(false)
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
            onClick={() => { player1.current?.reset(); player2.current?.reset(); player1.current?.setMuted(false); player2.current?.setMuted(false); setSyncPaused(true) }}
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