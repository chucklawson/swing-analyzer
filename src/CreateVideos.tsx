import { useRef, useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

const PRE_ROLL_MS         = 1000
const POST_ROLL_MS        = 3000
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

function makeFilename(ext: string) {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`
  const key   = `clip-count-${date}`
  const count = (parseInt(localStorage.getItem(key) ?? '0') + 1)
  localStorage.setItem(key, String(count))
  return `${date}-${count}-A.${ext}`
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
  const rafRef            = useRef<number | null>(null)

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
  const thresholdRef      = useRef(30)
  const mimeRef           = useRef('')
  const facingRef         = useRef<'environment' | 'user'>('environment')

  const [status,     setStatus]     = useState<'idle' | 'starting' | 'listening' | 'recording' | 'reviewing'>('idle')
  const [level,      setLevel]      = useState(0)
  const [threshold,  setThreshold]  = useState(30)
  const [facing,     setFacing]     = useState<'environment' | 'user'>('environment')
  const [saveFolder, setSaveFolder] = useState<string | null>(null)
  const [error,      setError]      = useState<string | null>(null)
  const [clipInfo,   setClipInfo]   = useState<string>('')
  const [reviewTap,  setReviewTap]  = useState(false)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasFsApi = 'showDirectoryPicker' in (window as any)

  useEffect(() => { thresholdRef.current = threshold }, [threshold])
  useEffect(() => () => teardown(), [])

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
          audio: true,
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
      startAudio(stream)
      startRollingRecorder()
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
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
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
    const src = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0
    src.connect(analyser)
    analyserRef.current = analyser

    const buf = new Uint8Array(analyser.frequencyBinCount)
    function tick() {
      analyser.getByteTimeDomainData(buf)
      let peak = 0
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128))
      const pct = Math.round((peak / 128) * 100)
      setLevel(pct)
      if (!cooldownRef.current && pct >= thresholdRef.current) trigger()
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
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

  function trigger() {
    cooldownRef.current  = true
    capturingRef.current = true
    setStatus('recording')
    triggerTimeRef.current = Date.now()
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
      setClipInfo(`init:${init ? '✓' : '✗'} chunks:${clipChunks.length}`)

      if (init && clipChunks.length > 0) {
        const ext = mime.includes('mp4') ? 'mp4' : 'webm'
        const processInit = mime.startsWith('video/webm') ? webmPureInit : mp4PureInit
        processInit(init).then(async initData => {
          let blob = new Blob([initData, ...clipChunks.map(c => c.data)], { type: mime })
          if (mime.startsWith('video/webm')) blob = await webmNormalizeTimecodes(blob)
          else if (mime.includes('mp4'))    blob = await mp4NormalizeTimecodes(blob)
          const filename = makeFilename(ext)
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

    // Append media error code to debug line so we can see why iOS rejects the blob
    rev.onerror = () => {
      const code = rev.error?.code ?? 0
      setClipInfo(prev => `${prev} err:${code}`)
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
    if (rafRef.current)           cancelAnimationFrame(rafRef.current)
    if (postRollTimerRef.current) clearTimeout(postRollTimerRef.current)
    if (reviewTimeoutRef.current) clearTimeout(reviewTimeoutRef.current)
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
  }

  const active = status === 'listening' || status === 'recording' || status === 'reviewing'

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col items-center p-4 gap-6">

      <div className="flex items-center gap-3 w-full max-w-2xl">
        <button
          onClick={() => { teardown(); navigate('/') }}
          className="w-8 h-8 rounded-full bg-gray-700 hover:bg-gray-600 flex items-center justify-center"
          title="Home"
        >⌂</button>
        <h1 className="text-3xl font-semibold tracking-tight">Create Videos</h1>
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

        {/* overlay layer — must sit above both video elements */}
        <div className="absolute inset-0" style={{ zIndex: 2, pointerEvents: 'none' }}>
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
          {status === 'reviewing' && (
            <div className="absolute top-3 left-3 flex items-center gap-2 bg-black/50 rounded-full px-3 py-1">
              <div className="w-2.5 h-2.5 rounded-full bg-blue-400" />
              <span className="text-white text-sm font-medium">Review</span>
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
          <div className="flex items-center gap-3">
            <span className="text-gray-400 text-sm w-16 shrink-0">Level</span>
            <div className="flex-1 h-3 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-75"
                style={{ width: `${level}%`, backgroundColor: level >= threshold ? '#ef4444' : '#22c55e' }}
              />
            </div>
            <span className="text-gray-500 text-sm w-10 text-right">{level}%</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-gray-400 text-sm w-16 shrink-0">Trigger</span>
            <input
              type="range" min={5} max={80} value={threshold}
              onChange={e => setThreshold(Number(e.target.value))}
              className="flex-1 accent-green-400"
            />
            <span className="text-gray-500 text-sm w-10 text-right">{threshold}%</span>
          </div>
          <p className="text-gray-600 text-xs text-center">
            Triggers when level exceeds threshold · 1s pre-roll · 3s clip
          </p>
          {clipInfo && (
            <p className="text-yellow-500 text-xs text-center font-mono">{clipInfo}</p>
          )}
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
