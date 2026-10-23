import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export type Landmark = { x: number; y: number; z: number }

export interface PoseSource {
  getLandmarks: () => Landmark[] | null
}

const BODY_CONNECTIONS: [number, number][] = [
  [11,12],[11,13],[13,15],[12,14],[14,16],
  [15,17],[15,19],[15,21],[16,18],[16,20],[16,22],
  [11,23],[12,24],[23,24],
  [23,25],[25,27],[24,26],[26,28],
  [27,29],[27,31],[29,31],[28,30],[28,32],[30,32],
]

function buildPoints(lm1: Landmark[], lm2: Landmark[]): THREE.Vector3[] {
  const cx1 = (lm1[11].x + lm1[12].x + lm1[23].x + lm1[24].x) / 4
  const cz2 = (lm2[11].x + lm2[12].x + lm2[23].x + lm2[24].x) / 4
  const topY  = lm1[0].y
  const botY  = (lm1[27].y + lm1[28].y) / 2
  const cy1   = (topY + botY) / 2
  const fullH = Math.abs(botY - topY)
  const scale = fullH > 0.01 ? 2.8 / fullH : 4
  return lm1.map((lm, i) => new THREE.Vector3(
    (lm.x     - cx1) * scale,
    -(lm.y    - cy1) * scale,
    (lm2[i].x - cz2) * scale,
  ))
}

export function ThreeDView({
  player1,
  player2,
  onClose,
}: {
  player1: React.RefObject<PoseSource | null>
  player2: React.RefObject<PoseSource | null>
  onClose: () => void
}) {
  const mountRef    = useRef<HTMLDivElement>(null)
  const animIdRef   = useRef<number | null>(null)
  const groupRef    = useRef<THREE.Group | null>(null)
  const rotationRef = useRef(0)
  const [sliderVal, setSliderVal] = useState(0)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0d0d0d)

    const w = mount.clientWidth, h = mount.clientHeight || 600
    const camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 100)
    camera.position.set(0, 0.5, 4)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(w, h)
    mount.appendChild(renderer.domElement)

    // Zoom + pan only — rotation handled by slider
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableRotate = false
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.target.set(0, 0, 0)
    controls.minDistance = 1
    controls.maxDistance = 12

    // Grid
    const grid = new THREE.GridHelper(6, 12, 0x2a2a2a, 0x1a1a1a)
    grid.position.y = -1.5
    scene.add(grid)

    // Axis arrows — orange=X, yellow=Y, cyan=Z
    const axisOrigin = new THREE.Vector3(0, -1.5, 0)
    const axisLen = 1.2, headLen = 0.18, headWidth = 0.1
    scene.add(new THREE.ArrowHelper(new THREE.Vector3(1,0,0), axisOrigin, axisLen, 0xff8800, headLen, headWidth))
    scene.add(new THREE.ArrowHelper(new THREE.Vector3(0,1,0), axisOrigin, axisLen, 0xffff00, headLen, headWidth))
    scene.add(new THREE.ArrowHelper(new THREE.Vector3(0,0,1), axisOrigin, axisLen, 0x00ccff, headLen, headWidth))

    // Group — rotated by slider
    const group = new THREE.Group()
    groupRef.current = group
    scene.add(group)

    // Bones
    const bonePosArr  = new Float32Array(BODY_CONNECTIONS.length * 2 * 3)
    const boneGeo     = new THREE.BufferGeometry()
    const bonePosAttr = new THREE.BufferAttribute(bonePosArr, 3)
    boneGeo.setAttribute('position', bonePosAttr)
    const boneLines = new THREE.LineSegments(boneGeo, new THREE.LineBasicMaterial({ color: 0x00ff88 }))
    group.add(boneLines)

    // Joints
    const jointPosArr  = new Float32Array(33 * 3)
    const jointGeo     = new THREE.BufferGeometry()
    const jointPosAttr = new THREE.BufferAttribute(jointPosArr, 3)
    jointGeo.setAttribute('position', jointPosAttr)
    const jointPoints = new THREE.Points(jointGeo, new THREE.PointsMaterial({ color: 0xff4444, size: 0.08, sizeAttenuation: true }))
    group.add(jointPoints)

    const resizeObs = new ResizeObserver(() => {
      const nw = mount.clientWidth, nh = mount.clientHeight
      if (!nw || !nh) return
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
      renderer.setSize(nw, nh)
    })
    resizeObs.observe(mount)

    function animate() {
      animIdRef.current = requestAnimationFrame(animate)

      // Apply slider rotation
      group.rotation.y = rotationRef.current * (Math.PI / 180)

      const lm1 = player1.current?.getLandmarks() ?? null
      const lm2 = player2.current?.getLandmarks() ?? null

      if (lm1 && lm2 && lm1.length >= 33 && lm2.length >= 33) {
        boneLines.visible = true
        jointPoints.visible = true
        const pts = buildPoints(lm1, lm2)
        BODY_CONNECTIONS.forEach(([a, b], i) => {
          bonePosAttr.setXYZ(i * 2,     pts[a].x, pts[a].y, pts[a].z)
          bonePosAttr.setXYZ(i * 2 + 1, pts[b].x, pts[b].y, pts[b].z)
        })
        bonePosAttr.needsUpdate = true
        pts.forEach((p, i) => jointPosAttr.setXYZ(i, p.x, p.y, p.z))
        jointPosAttr.needsUpdate = true
      } else {
        boneLines.visible = false
        jointPoints.visible = false
      }

      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      if (animIdRef.current) cancelAnimationFrame(animIdRef.current)
      resizeObs.disconnect()
      controls.dispose()
      renderer.dispose()
      groupRef.current = null
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
    }
  }, [player1, player2])

  function handleSlider(e: React.ChangeEvent<HTMLInputElement>) {
    const val = Number(e.target.value)
    rotationRef.current = val
    setSliderVal(val)
  }

  function resetRotation() {
    rotationRef.current = 0
    setSliderVal(0)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 bg-indigo-900 shrink-0">
        <div className="flex flex-col gap-1">
          <span className="text-white text-lg font-semibold">3D Skeleton View</span>
          <span className="text-indigo-300 text-sm">
            Scroll/pinch to zoom · <span style={{color:'#ff8800'}}>■</span> X · <span style={{color:'#ffff00'}}>■</span> Y · <span style={{color:'#00ccff'}}>■</span> Z
          </span>
        </div>
        <button onClick={onClose} className="text-indigo-300 hover:text-white text-2xl leading-none px-2">✕</button>
      </div>

      {/* Three.js canvas */}
      <div className="relative flex-1 min-h-0">
        <div ref={mountRef} className="w-full h-full" />
        <NoPoseOverlay player1={player1} player2={player2} />
      </div>

      {/* Rotation slider */}
      <div className="px-6 py-4 bg-gray-900 border-t border-gray-800 shrink-0">
        <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
          <span>-180°</span>
          <button
            onClick={resetRotation}
            className="text-gray-400 hover:text-white text-xs px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 transition-colors"
          >
            {sliderVal}° — Reset
          </button>
          <span>180°</span>
        </div>
        <div className="relative flex items-center">
          {/* Center tick */}
          <div className="absolute left-1/2 -translate-x-1/2 w-0.5 h-3 bg-gray-600 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="range"
            min={-180}
            max={180}
            value={sliderVal}
            onChange={handleSlider}
            className="w-full accent-indigo-500 cursor-pointer"
          />
        </div>
      </div>
    </div>
  )
}

function NoPoseOverlay({
  player1,
  player2,
}: {
  player1: React.RefObject<PoseSource | null>
  player2: React.RefObject<PoseSource | null>
}) {
  const lm1 = player1.current?.getLandmarks() ?? null
  const lm2 = player2.current?.getLandmarks() ?? null
  if (lm1 && lm2) return null
  const msg = !lm1 && !lm2
    ? 'Run 🦴 Pose on both videos to see the 3D skeleton'
    : !lm1
      ? 'Run 🦴 Pose on Video 1 (front view)'
      : 'Run 🦴 Pose on Video 2 (side view)'
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <p className="bg-black/75 text-gray-300 text-sm px-5 py-3 rounded-xl">{msg}</p>
    </div>
  )
}
