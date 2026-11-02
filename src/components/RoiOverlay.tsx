import { useRef, useEffect, useCallback } from 'react'
import type { NormalizedRect } from '../lib/swingConfig.ts'
import type { BallPosition } from '../lib/ballDetector.ts'
import {
  cssToNormalized,
  normalizedToCss,
  normalizedRectToCss,
  type VideoFitInfo,
} from '../lib/roiCoords.ts'

interface Props {
  roi: NormalizedRect
  onRoiChange: (roi: NormalizedRect) => void
  fitInfo: VideoFitInfo
  active: boolean       // false = dim, no interaction
  ballPos: BallPosition | null
}

type DragMode =
  | { kind: 'none' }
  | { kind: 'drawing'; startX: number; startY: number }
  | { kind: 'moving'; startX: number; startY: number; origRoi: NormalizedRect }
  | { kind: 'resizing'; handle: Handle; startX: number; startY: number; origRoi: NormalizedRect }

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

const HANDLE_RADIUS = 8
const MIN_NORM = 0.05  // minimum ROI dimension in normalised space

export default function RoiOverlay({ roi, onRoiChange, fitInfo, active, ballPos }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<DragMode>({ kind: 'none' })

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    const cssRoi = normalizedRectToCss(roi, fitInfo)

    // Dim overlay when inactive
    const alpha = active ? 1 : 0.4

    // Fill
    ctx.fillStyle = `rgba(255,255,255,${0.05 * alpha})`
    ctx.fillRect(cssRoi.x, cssRoi.y, cssRoi.w, cssRoi.h)

    // Border
    ctx.strokeStyle = `rgba(255,255,255,${0.7 * alpha})`
    ctx.lineWidth = 2
    ctx.strokeRect(cssRoi.x, cssRoi.y, cssRoi.w, cssRoi.h)

    if (!active) return

    // Ball crosshair — shown whenever ball is detected (regardless of drag state)
    if (ballPos !== null) {
      const [bx, by] = normalizedToCss(ballPos.nx, ballPos.ny, fitInfo)
      const [lx] = normalizedToCss(0, 0, fitInfo)
      const [rx] = normalizedToCss(1, 0, fitInfo)
      const ballR = Math.max(8, ballPos.radius * (rx - lx))
      const ARM = 20

      ctx.strokeStyle = 'rgba(34,197,94,0.9)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(bx - ARM, by); ctx.lineTo(bx + ARM, by)
      ctx.moveTo(bx, by - ARM); ctx.lineTo(bx, by + ARM)
      ctx.stroke()

      ctx.beginPath()
      ctx.arc(bx, by, ballR, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(34,197,94,0.7)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // Handles are only shown while the pointer is held down so they don't
    // clutter the view during normal recording.
    if (dragRef.current.kind === 'none') return

    const handles = handlePoints(cssRoi)
    for (const [, hx, hy] of handles) {
      ctx.beginPath()
      ctx.arc(hx, hy, HANDLE_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,0.4)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }, [roi, fitInfo, active, ballPos])

  useEffect(() => { draw() }, [draw])

  // Resize canvas to match container on mount and window resize
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const sync = () => {
      const parent = canvas.parentElement
      if (!parent) return
      const r = parent.getBoundingClientRect()
      canvas.width  = r.width
      canvas.height = r.height
      draw()
    }
    sync()
    const ro = new ResizeObserver(sync)
    const parent = canvas.parentElement
    if (parent) ro.observe(parent)
    return () => ro.disconnect()
  }, [draw])

  function handlePoints(r: { x: number; y: number; w: number; h: number }): [Handle, number, number][] {
    const cx = r.x + r.w / 2
    const cy = r.y + r.h / 2
    return [
      ['nw', r.x,         r.y        ],
      ['n',  cx,          r.y        ],
      ['ne', r.x + r.w,   r.y        ],
      ['e',  r.x + r.w,   cy         ],
      ['se', r.x + r.w,   r.y + r.h  ],
      ['s',  cx,          r.y + r.h  ],
      ['sw', r.x,         r.y + r.h  ],
      ['w',  r.x,         cy         ],
    ]
  }

  function hitHandle(px: number, py: number): Handle | null {
    const cssRoi = normalizedRectToCss(roi, fitInfo)
    for (const [name, hx, hy] of handlePoints(cssRoi)) {
      if (Math.hypot(px - hx, py - hy) <= HANDLE_RADIUS + 4) return name
    }
    return null
  }

  function insideRoi(px: number, py: number): boolean {
    const r = normalizedRectToCss(roi, fitInfo)
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h
  }

  function clampRoi(r: NormalizedRect): NormalizedRect {
    let { x, y, w, h } = r
    w = Math.max(MIN_NORM, w)
    h = Math.max(MIN_NORM, h)
    x = Math.max(0, Math.min(1 - w, x))
    y = Math.max(0, Math.min(1 - h, y))
    return { x, y, w, h }
  }

  function applyResize(handle: Handle, dx: number, dy: number, orig: NormalizedRect): NormalizedRect {
    // Convert dx/dy from CSS pixels to normalised delta
    const ndx = dx / fitInfo.containerW * (fitInfo.containerW / normalizedRectToCss({ x:0, y:0, w:1, h:1 }, fitInfo).w)
    const ndy = dy / fitInfo.containerH * (fitInfo.containerH / normalizedRectToCss({ x:0, y:0, w:1, h:1 }, fitInfo).h)

    let { x, y, w, h } = orig
    if (handle.includes('w')) { x += ndx; w -= ndx }
    if (handle.includes('e')) { w += ndx }
    if (handle.includes('n')) { y += ndy; h -= ndy }
    if (handle.includes('s')) { h += ndy }
    return clampRoi({ x, y, w, h })
  }

  function pointerToCanvas(e: React.PointerEvent<HTMLCanvasElement>): [number, number] {
    const r = canvasRef.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!active) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const [px, py] = pointerToCanvas(e)

    const handle = hitHandle(px, py)
    if (handle) {
      dragRef.current = { kind: 'resizing', handle, startX: px, startY: py, origRoi: { ...roi } }
    } else if (insideRoi(px, py)) {
      dragRef.current = { kind: 'moving', startX: px, startY: py, origRoi: { ...roi } }
    } else {
      dragRef.current = { kind: 'drawing', startX: px, startY: py }
    }
    draw()  // show handles immediately on touch
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = dragRef.current
    if (d.kind === 'none') return
    const [px, py] = pointerToCanvas(e)

    if (d.kind === 'drawing') {
      const [nx1, ny1] = cssToNormalized(Math.min(d.startX, px), Math.min(d.startY, py), fitInfo)
      const [nx2, ny2] = cssToNormalized(Math.max(d.startX, px), Math.max(d.startY, py), fitInfo)
      onRoiChange(clampRoi({ x: nx1, y: ny1, w: nx2 - nx1, h: ny2 - ny1 }))
      return
    }

    if (d.kind === 'moving') {
      const [ndx, ndy] = [
        (px - d.startX) / normalizedRectToCss({ x:0, y:0, w:1, h:1 }, fitInfo).w,
        (py - d.startY) / normalizedRectToCss({ x:0, y:0, w:1, h:1 }, fitInfo).h,
      ]
      onRoiChange(clampRoi({ ...d.origRoi, x: d.origRoi.x + ndx, y: d.origRoi.y + ndy }))
      return
    }

    if (d.kind === 'resizing') {
      onRoiChange(applyResize(d.handle, px - d.startX, py - d.startY, d.origRoi))
    }
  }

  function onPointerUp() {
    dragRef.current = { kind: 'none' }
    draw()  // erase handles as soon as pointer lifts
  }

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      style={{
        zIndex: 3,
        touchAction: 'none',
        cursor: active ? 'crosshair' : 'default',
        pointerEvents: active ? 'auto' : 'none',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  )
}
