import { useRef, useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { loadConfig, saveConfig, DEFAULT_CONFIG, type SwingConfig, type NormalizedRect } from './lib/swingConfig.ts'
import { AudioDetector } from './lib/audioDetector.ts'
import { SwingFusion } from './lib/swingFusion.ts'
import { TraceRecorder } from './lib/traceRecorder.ts'
import { BallDetector, type BallPosition } from './lib/ballDetector.ts'
import RoiOverlay from './components/RoiOverlay.tsx'
import DebugPanel from './components/DebugPanel.tsx'
import type { VideoFitInfo } from './lib/roiCoords.ts'

const PRE_ROLL_MS         = 1500
const POST_ROLL_MS        = 2000
const CHUNK_MS            = 100
const BUFFER_MS           = 1500
// Restart recorder only after each clip — keeps the init chunk close in time
// to the pre-roll chunks without randomly wiping the buffer mid-session.
const RECORDER_RESTART_MS = 60000

// iPadOS 13+ in desktop mode reports as MacIntel but has maxTouchPoints > 1
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const iosBrowser: 'chrome' | 'firefox' | 'edge' | 'safari' = (() => {
  if (!isIOS) return 'safari'
  const ua = navigator.userAgent
  if (/CriOS/.test(ua))  return 'chrome'
  if (/FxiOS/.test(ua))  return 'firefox'
  if (/EdgiOS/.test(ua)) return 'edge'
  return 'safari'
})()

interface Chunk { data: Blob; ts: number }

function makeFilename(ext: string, label: 'F' | 'D') {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const key   = `clip-count-${date}`
  const count = (parseInt(localStorage.getItem(key) ?? '0') + 1)
  localStorage.setItem(key, String(count))
  return `${date}_${time}_${count}_${label}.${ext}`
}

function pickMime() {
  // iOS claims VP9/WebM support via isTypeSupported but cannot decode WebM
  // in a video element, so force MP4 on all iOS/iPadOS devices.
  const order = isIOS
    ? ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4',
       'video/webm;codecs=vp9', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm',
       'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4']
  for (const t of order) {
    if (MediaRecorder.isTypeSupported(t)) return t
  }
  return ''
}

// Strip the first WebM Cluster from the init blob so the combined clip starts
// directly at the pre-roll data — no frozen t≈0 frame.
async function webmPureInit(initBlob: Blob): Promise<ArrayBuffer> {
  const buf = new Uint8Array(await initBlob.arrayBuffer())
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] === 0x1F && buf[i+1] === 0x43 && buf[i+2] === 0xB6 && buf[i+3] === 0x75) {
      return buf.buffer.slice(0, i)
    }
  }
  return buf.buffer
}

// Rewrite every Cluster Timecode in an assembled WebM blob so the first
// cluster is at T=0. Without this the clip starts at whatever absolute
// timestamp the rolling recorder was at when the pre-roll began, so the
// video element shows black for N seconds before any frame appears.
async function webmNormalizeTimecodes(blob: Blob): Promise<Blob> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let firstTimecode = -1

  for (let i = 0; i < buf.length - 20; i++) {
    if (buf[i] !== 0x1F || buf[i+1] !== 0x43 || buf[i+2] !== 0xB6 || buf[i+3] !== 0x75) continue

    // Determine the VINT length of the cluster size field
    const sb = buf[i + 4]
    let sizeLen = 8
    for (let b = 7; b >= 0; b--) { if (sb & (1 << b)) { sizeLen = 8 - b; break } }

    const tcOff = i + 4 + sizeLen
    if (tcOff + 4 >= buf.length || buf[tcOff] !== 0xE7) continue  // no Timecode element

    // VINT-decode the Timecode element's data size (typically 0x81 or 0x82)
    const tcSzByte = buf[tcOff + 1]
    let tcSize: number
    if      (tcSzByte & 0x80) tcSize = tcSzByte & 0x7F
    else if (tcSzByte & 0x40) tcSize = ((tcSzByte & 0x3F) << 8) | buf[tcOff + 2]
    else continue
    if (tcSize < 1 || tcSize > 4) continue

    let tcVal = 0
    for (let j = 0; j < tcSize; j++) tcVal = (tcVal << 8) | buf[tcOff + 2 + j]

    if (firstTimecode < 0) firstTimecode = tcVal
    let newTc = tcVal - firstTimecode
    for (let j = tcSize - 1; j >= 0; j--) { buf[tcOff + 2 + j] = newTc & 0xFF; newTc >>>= 8 }
  }

  return new Blob([buf], { type: blob.type })
}

// Strip any moof+mdat from the MP4 init blob — keep only ftyp+moov so the
// assembled clip starts cleanly at the pre-roll chunks (no t=0 gap).
async function mp4PureInit(initBlob: Blob): Promise<ArrayBuffer> {
  const buf = new Uint8Array(await initBlob.arrayBuffer())
  let i = 0
  while (i + 8 <= buf.length) {
    const size = ((buf[i] << 24) | (buf[i+1] << 16) | (buf[i+2] << 8) | buf[i+3]) >>> 0
    const type = String.fromCharCode(buf[i+4], buf[i+5], buf[i+6], buf[i+7])
    if (type === 'moof') return buf.buffer.slice(0, i)
    if (size < 8) break
    i += size
  }
  return buf.buffer
}

// Rewrite base_media_decode_time in every tfdt box so the first fragment
// of each track starts at T=0. iOS MediaRecorder embeds absolute session
// timestamps, so without this the assembled clip shows black from T=0 until
// the pre-roll window begins (often 10–60 s into the session).
async function mp4NormalizeTimecodes(blob: Blob): Promise<Blob> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  const firstTimes: Record<number, number> = {}

  const u32 = (o: number) => ((buf[o]<<24)|(buf[o+1]<<16)|(buf[o+2]<<8)|buf[o+3])>>>0

  // Proper recursive box walker — only reads tfhd/tfdt inside moof > traf,
  // avoiding false matches in mdat video frame data.
  function walkBoxes(start: number, end: number, inTraf: boolean, trackId: { v: number }) {
    let i = start
    while (i + 8 <= end) {
      const size = u32(i)
      if (size < 8 || i + size > end) break
      const type = String.fromCharCode(buf[i+4], buf[i+5], buf[i+6], buf[i+7])

      if (type === 'moof') walkBoxes(i + 8, i + size, false, { v: 0 })
      if (type === 'traf') walkBoxes(i + 8, i + size, true,  { v: 0 })

      if (inTraf) {
        if (type === 'tfhd') {
          // size(4)+type(4)+version(1)+flags(3) = 12 bytes before track_ID
          trackId.v = u32(i + 12)
        }
        if (type === 'tfdt') {
          const version = buf[i + 8]
          const toff    = i + 12   // skip size+type+version+flags
          let timeVal: number
          if (version === 1) {
            timeVal = u32(toff) * 4294967296 + u32(toff + 4)
          } else {
            timeVal = u32(toff)
          }
          const tid = trackId.v
          if (!(tid in firstTimes)) firstTimes[tid] = timeVal
          let t = timeVal - firstTimes[tid]
          if (version === 1) {
            const hi = Math.floor(t / 4294967296); const lo = t >>> 0
            buf[toff]=(hi>>>24)&0xFF; buf[toff+1]=(hi>>>16)&0xFF; buf[toff+2]=(hi>>>8)&0xFF; buf[toff+3]=hi&0xFF
            buf[toff+4]=(lo>>>24)&0xFF; buf[toff+5]=(lo>>>16)&0xFF; buf[toff+6]=(lo>>>8)&0xFF; buf[toff+7]=lo&0xFF
          } else {
            buf[toff]=(t>>>24)&0xFF; buf[toff+1]=(t>>>16)&0xFF; buf[toff+2]=(t>>>8)&0xFF; buf[toff+3]=t&0xFF
          }
        }
      }
      i += size
    }
  }

  walkBoxes(0, buf.length, false, { v: 0 })
  return new Blob([buf], { type: blob.type })
}

export default function CreateVideos() {
  const navigate = useNavigate()

  const videoRef          = useRef<HTMLVideoElement>(null)
  const reviewRef         = useRef<HTMLVideoElement>(null)
  const streamRef         = useRef<MediaStream | null>(null)
  const audioCtxRef       = useRef<AudioContext | null>(null)
  const analyserRef       = useRef<AnalyserNode | null>(null)
  const audioDetectorRef  = useRef<AudioDetector | null>(null)
  const gainNodeRef       = useRef<GainNode | null>(null)
  const swingFusionRef    = useRef<SwingFusion | null>(null)
  const traceRecorderRef  = useRef<TraceRecorder>(new TraceRecorder())

  const rollingRecRef     = useRef<MediaRecorder | null>(null)
  const rollingIntRef     = useRef<ReturnType<typeof setInterval> | null>(null)
  const restartTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const postRollTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reviewTimeoutRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rollingInitRef    = useRef<Blob | null>(null)
  const rollingChunksRef  = useRef<Chunk[]>([])
  const triggerTimeRef    = useRef<number | null>(null)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dirHandleRef      = useRef<any>(null)
  const cooldownRef       = useRef(false)
  const capturingRef      = useRef(false)
  const mimeRef           = useRef('')
  const facingRef         = useRef<'environment' | 'user'>('environment')
  const isFrontRef        = useRef(false)
  const ballDetectorRef   = useRef<BallDetector | null>(null)
  const roiRef            = useRef<NormalizedRect>(loadConfig().roi)
  const armedRef          = useRef(false)
  const configRef         = useRef<SwingConfig>(loadConfig())

  const [status,       setStatus]       = useState<'idle' | 'starting' | 'listening' | 'recording' | 'reviewing'>('idle')
  const [level,        setLevel]        = useState(0)
  const [facing,       setFacing]       = useState<'environment' | 'user'>('environment')
  const [saveFolder,   setSaveFolder]   = useState<string | null>(null)
  const [error,        setError]        = useState<string | null>(null)
  const [reviewTap,    setReviewTap]    = useState(false)
  const [config,       setConfig]       = useState<SwingConfig>(() => loadConfig())
  const [roi,          setRoi]          = useState<NormalizedRect>(() => loadConfig().roi)
  const [debugOpen,    setDebugOpen]    = useState(false)
  const [fusionLog,    setFusionLog]    = useState<string[]>([])
  const [fitInfo,      setFitInfo]      = useState<VideoFitInfo>({
    containerW: 640, containerH: 360,
    videoW: 1280,    videoH: 720,
    objectFit: 'cover',
  })
  const [isFront,      setIsFront]      = useState(false)
  const [armed,        setArmed]        = useState(false)
  const [bgLevel,      setBgLevel]      = useState(0)
  const [profiles,     setProfiles]     = useState<{ F: boolean; D: boolean }>(() => ({
    F: !!localStorage.getItem('swing-config-profile-F'),
    D: !!localStorage.getItem('swing-config-profile-D'),
  }))
  const [ballPos,      setBallPos]      = useState<BallPosition | null>(null)
  const ballDebugCanvasRef = useRef<HTMLCanvasElement>(null)
  const [debugPos,     setDebugPos]     = useState({ x: 10, y: 60 })
  const [ballDebugOpen, setBallDebugOpen] = useState(false)
  const debugDragRef   = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasFsApi = 'showDirectoryPicker' in (window as any)

  useEffect(() => () => teardown(), [])
  // Persist config when it changes
  useEffect(() => { saveConfig({ ...config, roi }) }, [config, roi])
  // Keep refs in sync so callbacks always read the latest values
  useEffect(() => { roiRef.current = roi }, [roi])
  useEffect(() => { configRef.current = config }, [config])
  // Wire debug canvas to ball detector after it renders; also clears it when closed
  useEffect(() => {
    const isActive = status === 'listening' || status === 'recording' || status === 'reviewing'
    if (isActive && config.ballDetectionEnabled && ballDetectorRef.current) {
      ballDetectorRef.current.setDebugCanvas(ballDebugOpen ? ballDebugCanvasRef.current : null)
    }
  }, [status, config.ballDetectionEnabled, ballDebugOpen])

  // Keep fitInfo in sync with the video element's actual dimensions
  const updateFitInfo = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    const container = video.parentElement
    if (!container) return
    const r = container.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return
    setFitInfo({
      containerW: r.width,
      containerH: r.height,
      videoW: video.videoWidth  || 1280,
      videoH: video.videoHeight || 720,
      objectFit: 'cover',
    })
  }, [])

  function saveProfile(type: 'F' | 'D') {
    localStorage.setItem(`swing-config-profile-${type}`, JSON.stringify({ ...config, roi }))
    setProfiles(prev => ({ ...prev, [type]: true }))
  }

  function loadProfile(type: 'F' | 'D') {
    const raw = localStorage.getItem(`swing-config-profile-${type}`)
    if (!raw) return
    try {
      const saved = JSON.parse(raw) as SwingConfig
      setConfig(saved)
      setRoi(saved.roi)
      audioDetectorRef.current?.updateConfig({ audioSpikeRatio: saved.audioSpikeRatio, audioBackgroundWindow: saved.audioBackgroundWindow })
      swingFusionRef.current?.updateConfig({ cooldownMs: saved.cooldownMs, fusionWindowMs: saved.fusionWindowMs })
      if (gainNodeRef.current) gainNodeRef.current.gain.value = saved.micGain
      ballDetectorRef.current?.updateConfig({ brightnessThreshold: saved.ballBrightnessThreshold, minBlobPixels: saved.ballMinPixels, maxBlobPixels: saved.ballMaxPixels })
    } catch { /* ignore corrupt data */ }
  }

  function exportTrace() {
    const json = traceRecorderRef.current.export()
    const blob = new Blob([json], { type: 'application/json' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url
    a.download = `swing-trace-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }


  async function pickFolder() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dir = await (window as any).showDirectoryPicker({ mode: 'readwrite' })
      dirHandleRef.current = dir
      setSaveFolder(dir.name)
    } catch { /* cancelled */ }
  }

  async function saveClip(blob: Blob, name: string) {
    // OPFS: silently back up to browser-private storage — no dialog, no user input.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((navigator.storage as any)?.getDirectory) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const root = await (navigator.storage as any).getDirectory()
        const fh = await root.getFileHandle(name, { create: true })
        const writable = await fh.createWritable()
        await writable.write(blob)
        await writable.close()
      } catch { /* non-fatal */ }
    }

    // Desktop FS API — if a folder is set, save silently there (no download dialog)
    if (dirHandleRef.current) {
      try {
        const fh = await dirHandleRef.current.getFileHandle(name, { create: true })
        const writable = await fh.createWritable()
        await writable.write(blob)
        await writable.close()
      } catch { /* non-fatal */ }
    }
  }


  async function start() {
    setStatus('starting')
    setError(null)
    try {
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facingRef.current }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: { echoCancellation: { ideal: false }, noiseSuppression: { ideal: false }, autoGainControl: { ideal: false } },
        })
      } catch (inner) {
        if ((inner as Error).name === 'NotAllowedError' || (inner as Error).name === 'PermissionDeniedError') throw inner
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facingRef.current } }, audio: true })
      }
      streamRef.current = stream

      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.play().catch(() => {})
      }

      mimeRef.current = pickMime()

      // Wire up fusion + detectors
      const fusion = new SwingFusion({
        fusionWindowMs:  config.fusionWindowMs,
        audioLookbackMs: config.audioLookbackMs,
        cooldownMs:      config.cooldownMs,
        audioOnlyMode:   true,
      })
      fusion.onSwing((audioTs) => {
        if (configRef.current.ballDetectionEnabled && !armedRef.current) return
        trigger(audioTs)
      })
      fusion.onRejected((reason, ts) => {
        const label = reason === 'audio-only' ? 'rejected: audio only'
          : reason === 'motion-only' ? 'rejected: motion only'
          : reason === 'cooldown'    ? 'rejected: cooldown'
          : 'rejected: ordering'
        const entry = `${new Date(ts).toLocaleTimeString()} ${label}`
        setFusionLog(prev => [...prev.slice(-19), entry])
        traceRecorderRef.current.record({ ts, motionScore: 0, audioLevel: level, decision: reason })
      })
      fusion.onCooldownEnd(() => { cooldownRef.current = false })
      swingFusionRef.current = fusion

      startAudio(stream)
      startRollingRecorder()

      if (config.ballDetectionEnabled && videoRef.current) {
        const bd = new BallDetector({
          brightnessThreshold: config.ballBrightnessThreshold,
          minBlobPixels: config.ballMinPixels,
          maxBlobPixels: config.ballMaxPixels,
          everyNthFrame: 2,
        })
        bd.onBallDetected(pos => { armedRef.current = true;  setArmed(true);  setBallPos(pos) })
        bd.onBallLost(()    => { armedRef.current = false; setArmed(false); setBallPos(null) })
        bd.start(videoRef.current, () => roiRef.current)
        ballDetectorRef.current = bd
      }


      // Keep fitInfo in sync after video metadata loads
      if (videoRef.current) {
        videoRef.current.addEventListener('loadedmetadata', updateFitInfo, { once: false })
      }
      updateFitInfo()

      setStatus('listening')
    } catch (err) {
      const name = (err as Error).name
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setError('denied')
      } else {
        setError(`Camera error: ${name || 'unknown'} — try closing other apps using the camera.`)
      }
      setStatus('idle')
    }
  }

  async function flipCamera() {
    const next: 'environment' | 'user' = facingRef.current === 'environment' ? 'user' : 'environment'
    facingRef.current = next
    setFacing(next)
    audioDetectorRef.current?.stop();  audioDetectorRef.current  = null
    swingFusionRef.current?.reset();   swingFusionRef.current    = null
    ballDetectorRef.current?.stop();   ballDetectorRef.current   = null
    armedRef.current = false; setArmed(false); setBallPos(null)
    stopRollingRecorder()
    streamRef.current?.getTracks().forEach(t => t.stop())
    audioCtxRef.current?.close()
    streamRef.current = null
    audioCtxRef.current = null
    analyserRef.current = null
    cooldownRef.current = false
    capturingRef.current = false
    await start()
  }

  function startAudio(stream: MediaStream) {
    const ctx = new AudioContext()
    audioCtxRef.current = ctx
    // iOS may create AudioContext in 'suspended' state even after user gesture
    ctx.resume().catch(() => {})
    const src = ctx.createMediaStreamSource(stream)
    const gain = ctx.createGain()
    gain.gain.value = config.micGain
    gainNodeRef.current = gain
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0
    src.connect(gain)
    gain.connect(analyser)
    analyserRef.current = analyser

    const detector = new AudioDetector(analyser, {
      audioSpikeRatio:       config.audioSpikeRatio,
      audioBackgroundWindow: config.audioBackgroundWindow,
    })
    detector.onLevelUpdate((pct) => { setLevel(pct); setBgLevel(detector.backgroundLevel()) })
    detector.onImpact((ts, pct) => {
      const fusion = swingFusionRef.current
      if (!fusion) return
      fusion.feedAudioImpact(ts, pct)
      const entry = `${new Date(ts).toLocaleTimeString()} FIRED audio impact (${pct}%)`
      setFusionLog(prev => [...prev.slice(-19), entry])
      traceRecorderRef.current.record({ ts, motionScore: 0, audioLevel: pct, decision: 'audio-impact' })
    })
    audioDetectorRef.current = detector
    detector.start()
  }

  function stopRollingRecorder() {
    if (restartTimerRef.current) { clearTimeout(restartTimerRef.current);  restartTimerRef.current  = null }
    if (rollingIntRef.current)   { clearInterval(rollingIntRef.current);   rollingIntRef.current    = null }
    rollingRecRef.current?.stop()
    rollingRecRef.current = null
  }

  function startRollingRecorder() {
    if (!streamRef.current) return
    const mime = mimeRef.current
    const rec  = new MediaRecorder(streamRef.current, mime ? { mimeType: mime } : undefined)
    // Read back the actual mimeType the browser chose (may differ from what we requested)
    if (rec.mimeType) mimeRef.current = rec.mimeType
    rollingRecRef.current   = rec
    rollingInitRef.current  = null
    rollingChunksRef.current = []

    rec.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return
      if (!rollingInitRef.current) { rollingInitRef.current = e.data; return }
      const chunk: Chunk = { data: e.data, ts: Date.now() }
      rollingChunksRef.current.push(chunk)
      if (!capturingRef.current) {
        const cutoff = Date.now() - BUFFER_MS
        rollingChunksRef.current = rollingChunksRef.current.filter(c => c.ts >= cutoff)
      }
    }

    rec.start(CHUNK_MS)
    rollingIntRef.current = setInterval(() => {
      if (rec.state === 'recording') rec.requestData()
    }, CHUNK_MS)

    // Periodic restart keeps the init chunk timestamps from drifting too far
    restartTimerRef.current = setTimeout(() => {
      if (!capturingRef.current && rec === rollingRecRef.current) {
        stopRollingRecorder()
        startRollingRecorder()
      }
    }, RECORDER_RESTART_MS)
  }

  function trigger(ts?: number) {
    cooldownRef.current  = true
    capturingRef.current = true
    setStatus('recording')
    triggerTimeRef.current = ts ?? Date.now()
    const fireEntry = `${new Date(triggerTimeRef.current).toLocaleTimeString()} FIRED swing`
    setFusionLog(prev => [...prev.slice(-19), fireEntry])
    if (restartTimerRef.current) { clearTimeout(restartTimerRef.current); restartTimerRef.current = null }
    postRollTimerRef.current = setTimeout(finalize, POST_ROLL_MS)
  }

  function finalize() {
    const rec = rollingRecRef.current
    if (!rec) return

    // Flush any unflushed data, then stop. All chunks (including any iOS
    // late-fired ondataavailable) arrive before onstop fires.
    if (rec.state === 'recording') rec.requestData()

    rec.addEventListener('stop', () => {
      const triggerTime = triggerTimeRef.current!
      const clipChunks  = rollingChunksRef.current.filter(c => c.ts >= triggerTime - PRE_ROLL_MS)
      const init        = rollingInitRef.current

      capturingRef.current   = false
      triggerTimeRef.current = null
      if (rollingIntRef.current)   { clearInterval(rollingIntRef.current);  rollingIntRef.current  = null }
      if (restartTimerRef.current) { clearTimeout(restartTimerRef.current); restartTimerRef.current = null }
      rollingRecRef.current    = null
      rollingInitRef.current   = null
      rollingChunksRef.current = []

      if (!streamRef.current) { cooldownRef.current = false; return }

      const mime = mimeRef.current || (isIOS ? 'video/mp4' : 'video/webm')

      if (init && clipChunks.length > 0) {
        const ext = mime.includes('mp4') ? 'mp4' : 'webm'
        const processInit = mime.startsWith('video/webm') ? webmPureInit : mp4PureInit
        processInit(init).then(async initData => {
          let blob = new Blob([initData, ...clipChunks.map(c => c.data)], { type: mime })
          if (mime.startsWith('video/webm')) blob = await webmNormalizeTimecodes(blob)
          else if (mime.includes('mp4'))    blob = await mp4NormalizeTimecodes(blob)
          const filename = makeFilename(ext, isFrontRef.current ? 'F' : 'D')
          saveClip(blob, filename)
          showReview(blob)
        })
      } else {
        setStatus('listening')
        cooldownRef.current = false
        startRollingRecorder()
      }
    }, { once: true })

    // Small pause so requestData chunk arrives before stop fires
    setTimeout(() => { if (rec.state === 'recording') rec.stop() }, 250)
  }

  function showReview(blob: Blob) {
    const rev = reviewRef.current
    if (!rev) {
      setStatus('listening'); cooldownRef.current = false; startRollingRecorder(); return
    }

    const url = URL.createObjectURL(blob)

    let done = false
    const finish = () => {
      if (done) return
      done = true
      if (reviewTimeoutRef.current) { clearTimeout(reviewTimeoutRef.current); reviewTimeoutRef.current = null }
      rev.onended          = null
      rev.oncanplay        = null
      rev.onloadeddata     = null
      rev.onloadedmetadata = null
      rev.onerror          = null
      rev.autoplay         = false
      if (!rev.paused) rev.pause()
      rev.removeAttribute('src')
      rev.load()
      URL.revokeObjectURL(url)
      if (videoRef.current) videoRef.current.style.visibility = ''
      setReviewTap(false)
      setStatus('listening'); cooldownRef.current = false; startRollingRecorder()
    }

    if (videoRef.current) videoRef.current.style.visibility = 'hidden'
    setStatus('reviewing')

    rev.onended = finish

    // Seek to the first seekable position — normalizeTimecodes should make
    // this T=0, but this is a safety net in case any offset slips through.
    rev.onloadedmetadata = () => {
      rev.onloadedmetadata = null
      if (rev.seekable.length > 0 && rev.seekable.start(0) > 0.05) {
        rev.currentTime = rev.seekable.start(0)
      }
    }

    // Set playback handlers BEFORE assigning src so events aren't missed
    let played = false
    const tryPlay = () => {
      if (played) return
      played = true
      rev.oncanplay    = null
      rev.onloadeddata = null
      rev.play().catch(() => setTimeout(() =>
        rev.play().catch(() => setReviewTap(true))   // show tap overlay if autoplay blocked
      , 300))
    }
    rev.oncanplay    = tryPlay
    rev.onloadeddata = tryPlay

    rev.onerror = () => {
      setReviewTap(true)
    }

    // Safety net: if neither canplay nor loadeddata fires within 500 ms, force a
    // play attempt anyway — iOS sometimes skips these events on blob URLs.
    setTimeout(() => { if (!played) tryPlay() }, 500)

    rev.muted    = true   // explicit — iOS autoplay requires muted
    rev.autoplay = true
    rev.setAttribute('playsinline', '')
    rev.src = url
    rev.load()
    reviewTimeoutRef.current = setTimeout(finish, PRE_ROLL_MS + POST_ROLL_MS + 5000)
  }

  function teardown() {
    if (postRollTimerRef.current) clearTimeout(postRollTimerRef.current)
    if (reviewTimeoutRef.current) clearTimeout(reviewTimeoutRef.current)
    audioDetectorRef.current?.stop();  audioDetectorRef.current  = null
    swingFusionRef.current?.reset();   swingFusionRef.current    = null
    ballDetectorRef.current?.stop();   ballDetectorRef.current   = null
    armedRef.current = false
    stopRollingRecorder()
    streamRef.current?.getTracks().forEach(t => t.stop())
    audioCtxRef.current?.close()
    streamRef.current    = null
    audioCtxRef.current  = null
    analyserRef.current  = null
    cooldownRef.current  = false
    capturingRef.current = false
    triggerTimeRef.current   = null
    rollingInitRef.current   = null
    rollingChunksRef.current = []
    setStatus('idle')
    setReviewTap(false)
    setLevel(0)
    setArmed(false)
    setBallPos(null)
  }

  const active = status === 'listening' || status === 'recording' || status === 'reviewing'
  const [showHelp, setShowHelp] = useState(false)

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col items-center p-4 gap-6">

      {/* ── In-app help overlay ── */}
      {showHelp && (
        <div
          className="fixed inset-0 bg-black/80 flex items-start justify-center overflow-y-auto"
          style={{ zIndex: 100 }}
          onClick={() => setShowHelp(false)}
        >
          <div
            className="relative bg-gray-900 rounded-2xl m-4 p-6 max-w-2xl w-full text-sm text-gray-200 flex flex-col gap-5"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setShowHelp(false)}
              className="absolute top-4 right-4 w-8 h-8 rounded-full bg-gray-700 hover:bg-gray-600 flex items-center justify-center text-gray-300 text-lg cursor-pointer"
              aria-label="Close help"
            >✕</button>

            <h2 className="text-xl font-semibold text-white">How to use Create Videos</h2>

            {/* Getting started */}
            <section className="flex flex-col gap-2">
              <h3 className="font-semibold text-green-400">Getting started</h3>
              <ol className="list-decimal list-inside flex flex-col gap-1 text-gray-300 leading-relaxed">
                <li>Tap <strong className="text-white">Start Camera</strong> and grant camera + microphone permission.</li>
                <li>Point the phone at your swing area so the ball is visible.</li>
                <li><strong className="text-white">Draw a box</strong> around the ball position by dragging on the video — keep it tight.</li>
                <li>Take your swing — a clip saves automatically when the impact sound is detected.</li>
                <li>The clip plays back immediately. Tap <strong className="text-white">⌂ Home</strong> → <strong className="text-white">Analyze My Swing</strong> to review it.</li>
              </ol>
              <p className="text-gray-400 text-xs leading-relaxed mt-1">For fewer false saves, enable <strong className="text-white">Require ball in ROI</strong> — the app will only save when a ball is visible in the box at the time of impact. See Ball Detection below.</p>
            </section>

            {/* Status badges */}
            <section className="flex flex-col gap-2">
              <h3 className="font-semibold text-green-400">Status badges (top-left of video)</h3>
              <div className="flex flex-col gap-1.5">
                {[
                  ['🟢 Listening',      'Ready — watching for an impact sound'],
                  ['🔴 Recording',      'Impact detected — capturing post-roll footage'],
                  ['🔵 Review · Saved', 'Playing back the just-saved clip'],
                ].map(([badge, desc]) => (
                  <div key={badge} className="flex gap-2">
                    <span className="text-white w-36 shrink-0">{badge}</span>
                    <span className="text-gray-400">{desc}</span>
                  </div>
                ))}
                <p className="text-gray-500 text-xs mt-1">When ball detection is on, a second badge appears below Listening:</p>
                {[
                  ['● Armed',           'Ball is visible in the ROI — a clip will save on next impact'],
                  ['● Waiting for ball','No ball detected yet — impact sound alone will not save a clip'],
                ].map(([badge, desc]) => (
                  <div key={badge} className="flex gap-2">
                    <span className="text-white w-36 shrink-0">{badge}</span>
                    <span className="text-gray-400">{desc}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* ROI box */}
            <section className="flex flex-col gap-2">
              <h3 className="font-semibold text-green-400">The ROI box (white rectangle)</h3>
              <p className="text-gray-300 leading-relaxed">The white rectangle is the <strong className="text-white">Region of Interest</strong> — the area the ball detector watches. Position it tightly around where the ball sits at address.</p>
              <ul className="list-disc list-inside flex flex-col gap-1 text-gray-300 leading-relaxed">
                <li><strong className="text-white">Draw new box</strong> — drag anywhere on the video from scratch</li>
                <li><strong className="text-white">Move box</strong> — tap and drag from inside the box</li>
                <li><strong className="text-white">Resize</strong> — drag any of the 8 white circular handles</li>
                <li><strong className="text-white">Reset box</strong> button — returns to the default center position</li>
                <li>When a ball is detected, a <strong className="text-white">green crosshair and circle</strong> appear on its position inside the box</li>
                <li>Box position is saved and restored automatically</li>
              </ul>
            </section>

            {/* Trigger logic */}
            <section className="flex flex-col gap-2">
              <h3 className="font-semibold text-green-400">When does a clip save?</h3>
              <p className="text-gray-300 leading-relaxed font-medium">Audio-only mode (default):</p>
              <p className="text-gray-300 leading-relaxed">A clip saves whenever a sharp impact sound — much louder than the background — is detected. Simple and reliable in quiet environments.</p>
              <p className="text-gray-300 leading-relaxed font-medium mt-1">With ball detection enabled:</p>
              <p className="text-gray-300 leading-relaxed">A clip only saves when <strong className="text-white">both</strong> conditions are true:</p>
              <ol className="list-decimal list-inside flex flex-col gap-1 text-gray-300 leading-relaxed">
                <li>A golf ball is visible in the ROI (<strong className="text-white">Armed</strong> badge is showing)</li>
                <li>An audio impact fires</li>
              </ol>
              <p className="text-gray-400 text-xs leading-relaxed mt-1">This prevents false saves from background noise, clapping, or any loud sound when no ball is present. A 7-second cooldown prevents multiple clips from a single swing.</p>
            </section>

            {/* Ball detection */}
            <section className="flex flex-col gap-2">
              <h3 className="font-semibold text-green-400">Ball detection</h3>
              <div className="flex flex-col gap-2">
                {[
                  ['Require ball in ROI', 'Master toggle. When checked, the app watches the ROI box every frame for a white golf ball. A clip only saves when the ball is confirmed visible (Armed) at the time of impact. Off by default.'],
                  ['Ball sens.', 'How much brighter than its background the ball must appear to be detected. Lower = more sensitive, picks up subtler balls. Higher = less sensitive, ignores weak highlights. Adjust until the Armed badge appears reliably when the ball is in the box and disappears when it is removed.'],
                  ['Show ball detector view', 'Opens a small draggable window on the video showing exactly what the detector sees: bright areas are highlighted orange-red, the detected ball is circled in green, and a stats bar at the bottom shows mean brightness, threshold, and blob size. Drag the "⠿ Ball View" title bar to move it anywhere on the screen. Use this to tune Ball sens. — you want the ball to light up orange-red while the background stays dim.'],
                ].map(([name, desc]) => (
                  <div key={name}>
                    <p className="text-white font-medium">{name}</p>
                    <p className="text-gray-400 text-xs leading-relaxed">{desc}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* Controls */}
            <section className="flex flex-col gap-2">
              <h3 className="font-semibold text-green-400">Other controls</h3>
              <div className="flex flex-col gap-2">
                {[
                  ['Audio sensitivity', 'How much louder than background a sound must be to count as an impact. Higher = only loud sharp strikes; lower = lighter contact also triggers. Default 2.5×.'],
                  ['Front checkbox', 'Checked = front/face-on view, filenames end in _F. Unchecked = down-the-line, filenames end in _D.'],
                  ['Flip camera icon', 'Top-right of video (visible when Listening) — switches between front and rear camera.'],
                  ['Reset box', 'Returns the ROI box to the default center position.'],
                ].map(([name, desc]) => (
                  <div key={name}>
                    <p className="text-white font-medium">{name}</p>
                    <p className="text-gray-400 text-xs leading-relaxed">{desc}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* Debug panel */}
            <section className="flex flex-col gap-2">
              <h3 className="font-semibold text-green-400">Debug panel</h3>
              <p className="text-gray-300 leading-relaxed">Tap <strong className="text-white">Debug</strong> to show a live audio level meter and a rolling log of the last 20 trigger decisions (FIRED / rejected: cooldown / audio only).</p>
            </section>

            {/* File names */}
            <section className="flex flex-col gap-2">
              <h3 className="font-semibold text-green-400">File names</h3>
              <p className="text-gray-300 leading-relaxed">Files are saved as <span className="font-mono text-green-300 text-xs">YYYYMMDD_HHMMSS_count_F.mp4</span> (or <span className="font-mono text-green-300 text-xs">_D.mp4</span>). The count resets each day. All clips are saved automatically to the browser's private storage (OPFS) and accessible from the My Clips browser on the home screen.</p>
            </section>


            <button
              onClick={() => setShowHelp(false)}
              className="mt-2 px-6 py-2.5 rounded-xl bg-green-400 hover:bg-green-300 text-black font-semibold active:scale-95 transition-all cursor-pointer self-center"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 w-full max-w-2xl">
        <button
          onClick={() => { teardown(); navigate('/') }}
          className="w-8 h-8 rounded-full bg-gray-700 hover:bg-gray-600 flex items-center justify-center"
          title="Home"
        >⌂</button>
        <h1 className="text-3xl font-semibold tracking-tight">Create Videos</h1>
        <button
          onClick={() => setShowHelp(true)}
          className="ml-auto w-8 h-8 rounded-full bg-gray-700 hover:bg-gray-600 flex items-center justify-center text-gray-300 font-semibold cursor-pointer"
          title="Help"
        >?</button>
      </div>

      <div className="w-full max-w-2xl aspect-video bg-black rounded-xl overflow-hidden relative">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          style={{ zIndex: status === 'reviewing' ? 0 : 1 }}
          playsInline muted
        />
        <video
          ref={reviewRef}
          className="absolute inset-0 w-full h-full object-cover"
          style={{ zIndex: status === 'reviewing' ? 1 : 0 }}
          playsInline muted
        />

        {/* ROI drawing overlay — zIndex 3, above status overlays */}
        <RoiOverlay
          roi={roi}
          onRoiChange={setRoi}
          fitInfo={fitInfo}
          active={status === 'listening'}
          ballPos={config.ballDetectionEnabled ? ballPos : null}
        />

        {/* Debug panel — zIndex 4 */}
        {debugOpen && (
          <DebugPanel
            audioLevel={level}
            config={config}
            fusionLog={fusionLog}
          />
        )}

        {/* overlay layer — zIndex 5, above ROI canvas (3) and DebugPanel (4) so status badges
             and flip button remain tappable. Parent has pointerEvents:none so it doesn't
             block ROI drawing; each interactive child re-enables it individually. */}
        <div className="absolute inset-0" style={{ zIndex: 5, pointerEvents: 'none' }}>
          {!active && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70" style={{ pointerEvents: 'auto' }}>
              <p className="text-gray-500">Camera off</p>
            </div>
          )}
          {status === 'recording' && (
            <div className="absolute top-3 left-3 flex items-center gap-2 bg-black/50 rounded-full px-3 py-1">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
              <span className="text-white text-sm font-medium">Recording</span>
            </div>
          )}
          {status === 'listening' && (
            <div className="absolute top-3 left-3 flex items-center gap-2 bg-black/50 rounded-full px-3 py-1">
              <div className="w-2.5 h-2.5 rounded-full bg-green-400" />
              <span className="text-white text-sm font-medium">Listening</span>
            </div>
          )}
          {status === 'listening' && config.ballDetectionEnabled && (
            <div className="absolute top-11 left-3 flex items-center gap-2 bg-black/50 rounded-full px-3 py-1">
              <div className={`w-2 h-2 rounded-full ${armed ? 'bg-green-400' : 'bg-yellow-400'}`} />
              <span className="text-white text-sm font-medium">{armed ? 'Armed' : 'Waiting for ball'}</span>
            </div>
          )}
          {status === 'reviewing' && (
            <div className="absolute top-3 left-3 flex items-center gap-2 bg-black/50 rounded-full px-3 py-1">
              <div className="w-2.5 h-2.5 rounded-full bg-blue-400" />
              <span className="text-white text-sm font-medium">Review · Saved ✓</span>
            </div>
          )}
          {status === 'reviewing' && reviewTap && (
            <button
              className="absolute inset-0 flex items-center justify-center"
              style={{ pointerEvents: 'auto', background: 'transparent' }}
              onClick={() => {
                setReviewTap(false)
                reviewRef.current?.play().catch(() => {})
              }}
            >
              <div className="w-20 h-20 rounded-full bg-black/50 flex items-center justify-center">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg>
              </div>
            </button>
          )}
          {status === 'listening' && (
            <button
              onClick={flipCamera}
              className="absolute top-3 right-3 w-9 h-9 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center transition-colors cursor-pointer"
              style={{ pointerEvents: 'auto' }}
              title={facing === 'environment' ? 'Switch to front camera' : 'Switch to back camera'}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                <path d="M16 3l-4 4-4-4"/>
                <circle cx="12" cy="13" r="3"/>
              </svg>
            </button>
          )}
        </div>

        {/* Ball detector debug view — zIndex 6, draggable */}
        {config.ballDetectionEnabled && active && ballDebugOpen && (
          <div
            className="absolute rounded-md overflow-hidden"
            style={{ zIndex: 6, left: debugPos.x, top: debugPos.y, boxShadow: '0 2px 8px rgba(0,0,0,0.6)' }}
          >
            <div
              className="bg-gray-900/90 text-gray-300 text-xs px-2 py-0.5 flex items-center gap-1 select-none"
              style={{ cursor: 'move', touchAction: 'none' }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                debugDragRef.current = { startX: e.clientX, startY: e.clientY, origX: debugPos.x, origY: debugPos.y }
              }}
              onPointerMove={(e) => {
                if (!debugDragRef.current) return
                const { startX, startY, origX, origY } = debugDragRef.current
                setDebugPos({ x: origX + e.clientX - startX, y: origY + e.clientY - startY })
              }}
              onPointerUp={() => { debugDragRef.current = null }}
              onPointerCancel={() => { debugDragRef.current = null }}
            >
              ⠿ Ball View
            </div>
            <canvas
              ref={ballDebugCanvasRef}
              width={128}
              height={128}
              style={{ display: 'block', width: 192, height: 192, imageRendering: 'pixelated' }}
            />
          </div>
        )}
      </div>

      {error && (
        <div className="w-full max-w-2xl">
          {error === 'denied' ? (
            <div className="bg-gray-800 rounded-xl p-5 flex flex-col gap-3">
              <p className="text-red-400 font-semibold">Camera &amp; microphone access blocked</p>
              {isIOS ? (
                <div className="flex flex-col gap-4 text-sm text-gray-300">
                  <p className="text-gray-500 text-xs">Detected browser: iOS {iosBrowser.charAt(0).toUpperCase() + iosBrowser.slice(1)}</p>

                  {iosBrowser === 'chrome' && <>
                    <div className="bg-gray-700/50 rounded-lg p-3">
                      <p className="text-green-400 font-medium mb-1.5">Fix for this site (try this first):</p>
                      <ol className="flex flex-col gap-1 list-decimal list-inside leading-relaxed">
                        <li>Tap the <strong className="text-white">lock icon</strong> in Chrome's address bar</li>
                        <li>Tap <strong className="text-white">Website settings</strong></li>
                        <li>Set <strong className="text-white">Camera</strong> and <strong className="text-white">Microphone</strong> to <strong className="text-white">Allow</strong></li>
                        <li>Return here and tap <strong className="text-white">Start Camera</strong></li>
                      </ol>
                    </div>
                    <div>
                      <p className="text-gray-400 mb-1.5">Or via iOS Settings:</p>
                      <ol className="flex flex-col gap-1 list-decimal list-inside leading-relaxed">
                        <li>Open <strong className="text-white">Settings</strong> → scroll to <strong className="text-white">Chrome</strong></li>
                        <li>Enable <strong className="text-white">Camera</strong> and <strong className="text-white">Microphone</strong></li>
                        <li>Return to Chrome and tap <strong className="text-white">Start Camera</strong></li>
                      </ol>
                    </div>
                  </>}

                  {iosBrowser === 'safari' && <>
                    <div className="bg-gray-700/50 rounded-lg p-3">
                      <p className="text-green-400 font-medium mb-1.5">Fix for this site (try this first):</p>
                      <ol className="flex flex-col gap-1 list-decimal list-inside leading-relaxed">
                        <li>Tap <strong className="text-white">AA</strong> in Safari's address bar</li>
                        <li>Tap <strong className="text-white">Website Settings</strong></li>
                        <li>Set <strong className="text-white">Camera</strong> and <strong className="text-white">Microphone</strong> to <strong className="text-white">Allow</strong></li>
                        <li>Tap <strong className="text-white">Done</strong>, then tap <strong className="text-white">Start Camera</strong></li>
                      </ol>
                    </div>
                    <div>
                      <p className="text-gray-400 mb-1.5">Or via iOS Settings:</p>
                      <ol className="flex flex-col gap-1 list-decimal list-inside leading-relaxed">
                        <li>Open <strong className="text-white">Settings</strong> → <strong className="text-white">Apps</strong> → <strong className="text-white">Safari</strong></li>
                        <li>Tap <strong className="text-white">Settings for Websites</strong></li>
                        <li>Set <strong className="text-white">Camera</strong> and <strong className="text-white">Microphone</strong> to <strong className="text-white">Allow</strong></li>
                        <li>Return here and tap <strong className="text-white">Start Camera</strong></li>
                      </ol>
                    </div>
                  </>}

                  {(iosBrowser === 'firefox' || iosBrowser === 'edge') && <>
                    <div className="bg-gray-700/50 rounded-lg p-3">
                      <p className="text-green-400 font-medium mb-1.5">Via iOS Settings:</p>
                      <ol className="flex flex-col gap-1 list-decimal list-inside leading-relaxed">
                        <li>Open <strong className="text-white">Settings</strong> → scroll to <strong className="text-white">{iosBrowser === 'firefox' ? 'Firefox' : 'Edge'}</strong></li>
                        <li>Enable <strong className="text-white">Camera</strong> and <strong className="text-white">Microphone</strong></li>
                        <li>Return here and tap <strong className="text-white">Start Camera</strong></li>
                      </ol>
                    </div>
                  </>}
                </div>
              ) : (
                <p className="text-gray-300 text-sm">
                  Click the lock or camera icon in the browser address bar, allow camera and microphone for this site, then tap <strong>Start Camera</strong> again.
                </p>
              )}
            </div>
          ) : (
            <p className="text-red-400 text-sm text-center">{error}</p>
          )}
        </div>
      )}

      {active && (
        <div className="w-full max-w-2xl flex flex-col gap-3">
          {/* Audio level bar */}
          <div className="flex items-center gap-3">
            <span className="text-gray-400 text-sm w-20 shrink-0">Audio</span>
            <div className="flex-1 h-3 relative">
              <div className="absolute inset-0 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-75"
                  style={{ width: `${level}%`, backgroundColor: '#22c55e' }}
                />
              </div>
              <div
                className="absolute top-0 h-full w-0.5 bg-yellow-400 rounded-full"
                style={{ left: `${Math.min(99, Math.max(bgLevel, 5) * config.audioSpikeRatio)}%`, transform: 'translateX(-50%)' }}
              />
            </div>
            <span className="text-gray-500 text-sm w-10 text-right">{level}%</span>
          </div>

          {/* Mic boost slider */}
          <div className="flex items-center gap-3">
            <span className="text-gray-400 text-sm w-20 shrink-0">Mic boost</span>
            <input
              type="range" min={1} max={10} step={0.5} value={config.micGain}
              onChange={e => {
                const v = Number(e.target.value)
                setConfig(prev => ({ ...prev, micGain: v }))
                if (gainNodeRef.current) gainNodeRef.current.gain.value = v
              }}
              className="flex-1 accent-green-400"
            />
            <span className="text-gray-500 text-sm w-10 text-right">{config.micGain}×</span>
          </div>

          {/* Audio sensitivity slider */}
          <div className="flex items-center gap-3">
            <span className="text-gray-400 text-sm w-20 shrink-0">Audio sens.</span>
            <input
              type="range" min={1.2} max={6} step={0.1} value={config.audioSpikeRatio}
              onChange={e => {
                const v = Number(e.target.value)
                setConfig(prev => ({ ...prev, audioSpikeRatio: v }))
                audioDetectorRef.current?.updateConfig({ audioSpikeRatio: v })
              }}
              className="flex-1 accent-green-400"
            />
            <span className="text-gray-500 text-sm w-10 text-right">{config.audioSpikeRatio.toFixed(1)}×</span>
          </div>

          {/* Fusion window slider */}
          <div className="flex items-center gap-3">
            <span className="text-gray-400 text-sm w-20 shrink-0">Window</span>
            <input
              type="range" min={100} max={800} step={50} value={config.fusionWindowMs}
              onChange={e => {
                const v = Number(e.target.value)
                setConfig(prev => ({ ...prev, fusionWindowMs: v }))
                swingFusionRef.current?.updateConfig({ fusionWindowMs: v })
              }}
              className="flex-1 accent-blue-400"
            />
            <span className="text-gray-500 text-sm w-12 text-right">{config.fusionWindowMs} ms</span>
          </div>

          {/* Cooldown slider */}
          <div className="flex items-center gap-3">
            <span className="text-gray-400 text-sm w-20 shrink-0">Cooldown</span>
            <input
              type="range" min={3000} max={15000} step={1000} value={config.cooldownMs}
              onChange={e => {
                const v = Number(e.target.value)
                setConfig(prev => ({ ...prev, cooldownMs: v }))
                swingFusionRef.current?.updateConfig({ cooldownMs: v })
              }}
              className="flex-1 accent-orange-400"
            />
            <span className="text-gray-500 text-sm w-10 text-right">{config.cooldownMs / 1000}s</span>
          </div>

          {/* Ball detection toggle + sensitivity */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={config.ballDetectionEnabled}
              onChange={e => {
                const v = e.target.checked
                setConfig(prev => ({ ...prev, ballDetectionEnabled: v }))
                if (!v) {
                  ballDetectorRef.current?.stop()
                  ballDetectorRef.current = null
                  armedRef.current = false; setArmed(false); setBallPos(null)
                } else if (videoRef.current) {
                  const bd = new BallDetector({
                    brightnessThreshold: config.ballBrightnessThreshold,
                    minBlobPixels: config.ballMinPixels,
                    maxBlobPixels: config.ballMaxPixels,
                    everyNthFrame: 2,
                  })
                  bd.onBallDetected(pos => { armedRef.current = true;  setArmed(true);  setBallPos(pos) })
                  bd.onBallLost(()    => { armedRef.current = false; setArmed(false); setBallPos(null) })
                  bd.start(videoRef.current, () => roiRef.current)
                  ballDetectorRef.current = bd
                }
              }}
              className="w-4 h-4 accent-green-400 cursor-pointer"
            />
            <span className="text-gray-300 text-sm">Require ball in ROI before saving</span>
          </label>

          {config.ballDetectionEnabled && (
            <>
              <div className="flex items-center gap-3">
                <span className="text-gray-400 text-sm w-20 shrink-0">Ball sens.</span>
                <input
                  type="range" min={5} max={60} step={5} value={config.ballBrightnessThreshold}
                  onChange={e => {
                    const v = Number(e.target.value)
                    setConfig(prev => ({ ...prev, ballBrightnessThreshold: v }))
                    ballDetectorRef.current?.updateConfig({ brightnessThreshold: v })
                  }}
                  className="flex-1 accent-green-400"
                />
                <span className="text-gray-500 text-sm w-10 text-right">{config.ballBrightnessThreshold}</span>
              </div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={ballDebugOpen}
                  onChange={e => setBallDebugOpen(e.target.checked)}
                  className="w-4 h-4 accent-green-400 cursor-pointer"
                />
                <span className="text-gray-300 text-sm">Show ball detector view</span>
              </label>
            </>
          )}

          {/* View profiles */}
          <div className="flex items-center gap-3">
            <span className="text-gray-400 text-sm w-20 shrink-0">Profiles</span>
            <div className="flex gap-2 flex-wrap flex-1">
              {(['F', 'D'] as const).map(type => (
                <div key={type} className="flex gap-1">
                  <button
                    onClick={() => saveProfile(type)}
                    className="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs cursor-pointer"
                  >
                    Save {type === 'F' ? 'Front' : 'DTL'}
                  </button>
                  <button
                    onClick={() => loadProfile(type)}
                    disabled={!profiles[type]}
                    className="px-3 py-1.5 rounded-lg text-xs cursor-pointer disabled:opacity-30 disabled:cursor-default bg-green-800 hover:bg-green-700 text-green-200"
                  >
                    Load {type === 'F' ? 'Front' : 'DTL'}
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Action row: ROI hint, Calibrate, Debug, Reset box, Export */}
          <div className="flex flex-wrap gap-2 items-center justify-between">
            <p className="text-gray-600 text-xs flex-1 min-w-48">
              Draw a box around the ball &amp; club head area, then keep the camera still.
            </p>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => setRoi(DEFAULT_CONFIG.roi)}
                className="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs cursor-pointer"
              >
                Reset box
              </button>
              <button
                onClick={() => setDebugOpen(v => !v)}
                className={`px-3 py-1.5 rounded-lg text-xs cursor-pointer ${debugOpen ? 'bg-blue-700 text-blue-100' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
              >
                Debug
              </button>
              {config.traceEnabled && (
                <button
                  onClick={exportTrace}
                  className="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs cursor-pointer"
                >
                  Export trace
                </button>
              )}
            </div>
          </div>


          <p className="text-gray-600 text-xs text-center">
            Clip saves on audio impact · {PRE_ROLL_MS/1000}s pre-roll · {POST_ROLL_MS/1000}s post-roll
          </p>
        </div>
      )}

      {hasFsApi && (
        <div className="w-full max-w-2xl">
          <button
            onClick={pickFolder}
            className="w-full px-4 py-2.5 rounded-xl border border-gray-700 hover:border-gray-500 text-sm text-left cursor-pointer transition-colors"
            style={{ color: saveFolder ? '#86efac' : '#9ca3af' }}
          >
            {saveFolder
              ? `Save folder: ${saveFolder}`
              : 'Set save folder — clips save silently here (no download dialog)'}
          </button>
        </div>
      )}

      <div className="w-full max-w-2xl flex items-center justify-between">
        <label className="flex items-center gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={isFront}
            onChange={e => {
              setIsFront(e.target.checked)
              isFrontRef.current = e.target.checked
            }}
            className="w-4 h-4 accent-green-400 cursor-pointer"
          />
          <span className="text-gray-300 text-sm">
            Front <span className="text-gray-500 text-xs ml-1">(unchecked = Down the line · files saved as …_{isFront ? 'F' : 'D'}.mp4)</span>
          </span>
        </label>
      </div>

      <div className="flex gap-3">
        {status === 'idle' || status === 'starting' ? (
          <button
            onClick={start}
            disabled={status === 'starting'}
            className="px-8 py-3 rounded-xl bg-green-400 hover:bg-green-300 text-black font-semibold active:scale-95 transition-all disabled:opacity-50 cursor-pointer"
          >
            {status === 'starting' ? 'Starting…' : 'Start Camera'}
          </button>
        ) : (
          <button
            onClick={teardown}
            className="px-8 py-3 rounded-xl bg-gray-700 hover:bg-gray-600 text-white font-semibold active:scale-95 transition-all cursor-pointer"
          >
            Stop
          </button>
        )}
      </div>

    </div>
  )
}
