import { useRef, useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

const PRE_ROLL_MS         = 1000
const POST_ROLL_MS        = 3000
const CHUNK_MS            = 100
const BUFFER_MS           = 1500
// Restart recorder only after each clip — keeps the init chunk close in time
// to the pre-roll chunks without randomly wiping the buffer mid-session.
const RECORDER_RESTART_MS = 60000

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
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
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-A.${ext}`
}

function pickMime() {
  for (const t of ['video/webm;codecs=vp9', 'video/webm', 'video/mp4']) {
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

export default function CreateVideos() {
  const navigate = useNavigate()

  const videoRef          = useRef<HTMLVideoElement>(null)
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
      try {
        const fh = await dirHandleRef.current.getFileHandle(name, { create: true })
        const writable = await fh.createWritable()
        await writable.write(blob)
        await writable.close()
        return
      } catch { /* fall through */ }
    }
    if (isIOS) return   // iOS — no download sheet; S3 upload goes here later
    // Desktop (no folder set) or Android
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

      if (init && clipChunks.length > 0) {
        const mime = mimeRef.current || 'video/webm'
        const ext  = mime.includes('mp4') ? 'mp4' : 'webm'
        ;(mime.startsWith('video/webm') ? webmPureInit(init) : init.arrayBuffer()).then(initData => {
          const blob = new Blob([initData, ...clipChunks.map(c => c.data)], { type: mime })
          saveClip(blob, makeFilename(ext))
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
    const vid = videoRef.current
    if (!vid) {
      setStatus('listening'); cooldownRef.current = false; startRollingRecorder(); return
    }

    const url = URL.createObjectURL(blob)

    let done = false
    const finish = () => {
      if (done) return
      done = true
      if (reviewTimeoutRef.current) { clearTimeout(reviewTimeoutRef.current); reviewTimeoutRef.current = null }
      vid.onended   = null
      vid.oncanplay = null
      if (!vid.paused) vid.pause()
      vid.src = ''
      URL.revokeObjectURL(url)
      // Restore live feed on the same element
      if (streamRef.current) {
        vid.srcObject = streamRef.current
        vid.play().catch(() => {})
      }
      setStatus('listening'); cooldownRef.current = false; startRollingRecorder()
    }

    setStatus('reviewing')
    vid.srcObject = null   // detach live stream
    vid.src = url
    vid.load()
    vid.onended = finish
    reviewTimeoutRef.current = setTimeout(finish, PRE_ROLL_MS + POST_ROLL_MS + 5000)

    const doPlay = () => vid.play().catch(finish)
    if (vid.readyState >= 2) {
      doPlay()
    } else {
      vid.oncanplay = () => { vid.oncanplay = null; doPlay() }
    }
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
          playsInline muted
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
        {status === 'listening' && (
          <button
            onClick={flipCamera}
            className="absolute top-3 right-3 w-9 h-9 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center transition-colors cursor-pointer"
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
