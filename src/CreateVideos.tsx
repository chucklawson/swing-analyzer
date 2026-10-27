import { useRef, useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

const POST_ROLL_MS = 3000   // record this long after impact
const CHUNK_MS     = 100    // timeslice + requestData interval

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)

function makeFilename(ext: string) {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-A.${ext}`
}

function pickMime() {
  for (const t of ['video/webm;codecs=vp9', 'video/webm', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported(t)) return t
  }
  return ''
}

export default function CreateVideos() {
  const navigate = useNavigate()

  const videoRef        = useRef<HTMLVideoElement>(null)
  const reviewRef       = useRef<HTMLVideoElement>(null)
  const streamRef       = useRef<MediaStream | null>(null)
  const audioCtxRef     = useRef<AudioContext | null>(null)
  const analyserRef     = useRef<AnalyserNode | null>(null)
  const rafRef          = useRef<number | null>(null)
  const clipRecorderRef = useRef<MediaRecorder | null>(null)
  const clipTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clipIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dirHandleRef    = useRef<any>(null)
  const cooldownRef     = useRef(false)
  const thresholdRef    = useRef(30)
  const mimeRef         = useRef('')

  const [status,     setStatus]     = useState<'idle' | 'starting' | 'listening' | 'recording' | 'reviewing'>('idle')
  const [level,      setLevel]      = useState(0)
  const [threshold,  setThreshold]  = useState(30)
  const [saveFolder, setSaveFolder] = useState<string | null>(null)
  const [error,      setError]      = useState<string | null>(null)

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
    if (dirHandleRef.current) {
      // Silent save to chosen folder — no browser dialog
      try {
        const fh = await dirHandleRef.current.getFileHandle(name, { create: true })
        const writable = await fh.createWritable()
        await writable.write(blob)
        await writable.close()
        return
      } catch { /* fall through */ }
    }
    if (hasFsApi) {
      // Desktop Chrome/Edge but no folder chosen yet — skip save, no popup
      return
    }
    // Mobile (iOS, Android): system share/Files sheet
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  async function start() {
    setStatus('starting')
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      })
      streamRef.current = stream

      // Explicit play() required on iOS — autoPlay alone is not enough for srcObject
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.play().catch(() => {})
      }

      mimeRef.current = pickMime()
      startAudio(stream)
      setStatus('listening')
    } catch (err) {
      const name = (err as Error).name
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setError('denied')
      } else {
        setError('Could not access camera or microphone.')
      }
      setStatus('idle')
    }
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

  function trigger() {
    if (!streamRef.current) return
    cooldownRef.current = true
    setStatus('recording')

    const mime = mimeRef.current
    const chunks: Blob[] = []

    // Fresh recorder per clip — timestamps start at 0, no discontinuity
    const recorder = new MediaRecorder(streamRef.current, mime ? { mimeType: mime } : undefined)
    clipRecorderRef.current = recorder

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data)
    }

    recorder.onstop = () => {
      clipRecorderRef.current = null
      if (clipIntervalRef.current) { clearInterval(clipIntervalRef.current); clipIntervalRef.current = null }

      if (!streamRef.current) { cooldownRef.current = false; return }  // torn down mid-clip

      if (chunks.length > 0) {
        const blob = new Blob(chunks, { type: mime || 'video/webm' })
        const ext  = mime.includes('mp4') ? 'mp4' : 'webm'
        saveClip(blob, makeFilename(ext))
        showReview(blob)
      } else {
        setStatus('listening')
        cooldownRef.current = false
      }
    }

    recorder.start(CHUNK_MS)

    // Force periodic data on iOS which may ignore timeslice
    clipIntervalRef.current = setInterval(() => {
      if (recorder.state === 'recording') recorder.requestData()
    }, CHUNK_MS)

    clipTimerRef.current = setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop()
    }, POST_ROLL_MS)
  }

  function showReview(blob: Blob) {
    const url = URL.createObjectURL(blob)
    const rev = reviewRef.current
    if (!rev) {
      URL.revokeObjectURL(url)
      setStatus('listening')
      cooldownRef.current = false
      return
    }
    setStatus('reviewing')
    rev.src = url
    rev.currentTime = 0
    rev.play().catch(() => {})
    rev.onended = () => {
      rev.onended = null
      rev.src = ''
      URL.revokeObjectURL(url)
      setStatus('listening')
      cooldownRef.current = false
    }
  }

  function teardown() {
    if (rafRef.current)          cancelAnimationFrame(rafRef.current)
    if (clipTimerRef.current)    clearTimeout(clipTimerRef.current)
    if (clipIntervalRef.current) clearInterval(clipIntervalRef.current)
    clipRecorderRef.current?.stop()
    streamRef.current?.getTracks().forEach(t => t.stop())
    audioCtxRef.current?.close()
    streamRef.current       = null
    clipRecorderRef.current = null
    audioCtxRef.current     = null
    cooldownRef.current     = false
    setStatus('idle')
    setLevel(0)
  }

  const active = status === 'listening' || status === 'recording' || status === 'reviewing'

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col items-center p-4 gap-6">

      {/* Header */}
      <div className="flex items-center gap-3 w-full max-w-2xl">
        <button
          onClick={() => { teardown(); navigate('/') }}
          className="w-8 h-8 rounded-full bg-gray-700 hover:bg-gray-600 flex items-center justify-center"
          title="Home"
        >⌂</button>
        <h1 className="text-3xl font-semibold tracking-tight">Create Videos</h1>
      </div>

      {/* Camera preview / review */}
      <div className="w-full max-w-2xl aspect-video bg-black rounded-xl overflow-hidden relative">
        {/* Live stream — hidden during review */}
        <video
          ref={videoRef}
          className={`w-full h-full object-cover ${status === 'reviewing' ? 'hidden' : ''}`}
          playsInline
          muted
        />
        {/* Clip playback — only visible during review */}
        <video
          ref={reviewRef}
          className={`w-full h-full object-cover ${status === 'reviewing' ? '' : 'hidden'}`}
          playsInline
          muted
        />

        {!active && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70">
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
      </div>

      {error && (
        <div className="w-full max-w-2xl">
          {error === 'denied' ? (
            <div className="bg-gray-800 rounded-xl p-5 flex flex-col gap-3">
              <p className="text-red-400 font-semibold">Camera &amp; microphone access blocked</p>
              {isIOS ? (
                <div className="flex flex-col gap-4 text-sm text-gray-300">
                  <div>
                    <p className="text-gray-400 mb-1.5">Quick fix — reset permission for this page:</p>
                    <ol className="flex flex-col gap-1 list-decimal list-inside leading-relaxed">
                      <li>Tap <strong className="text-white">AA</strong> in the Safari address bar (or long-press the reload button)</li>
                      <li>Tap <strong className="text-white">Website Settings</strong></li>
                      <li>Set <strong className="text-white">Camera</strong> and <strong className="text-white">Microphone</strong> to <strong className="text-white">Allow</strong></li>
                      <li>Tap <strong className="text-white">Done</strong>, then tap <strong className="text-white">Start Camera</strong> below</li>
                    </ol>
                  </div>
                  <div>
                    <p className="text-gray-400 mb-1.5">Or fix it in Settings:</p>
                    <ol className="flex flex-col gap-1 list-decimal list-inside leading-relaxed">
                      <li>Open the <strong className="text-white">Settings</strong> app</li>
                      <li>Scroll down and tap <strong className="text-white">Safari</strong></li>
                      <li>Under <em>Settings for Websites</em> → tap <strong className="text-white">Camera</strong> → <strong className="text-white">Allow</strong></li>
                      <li>Do the same for <strong className="text-white">Microphone</strong></li>
                      <li>Return here and tap <strong className="text-white">Start Camera</strong></li>
                    </ol>
                  </div>
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

      {/* Level + threshold */}
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
            Triggers when level exceeds threshold · 3s clip
          </p>
        </div>
      )}

      {/* Save folder — Chrome / Edge desktop only */}
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

      {/* Start / Stop */}
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
