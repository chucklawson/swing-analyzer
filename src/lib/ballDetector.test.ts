import { describe, it, expect, vi } from 'vitest'
import { findBestBlob, BallDetector } from './ballDetector.ts'

function makeBright(w: number, h: number, pixels: [number, number][]): Uint8Array {
  const arr = new Uint8Array(w * h)
  for (const [x, y] of pixels) arr[y * w + x] = 1
  return arr
}

function makeRect(w: number, h: number, rx: number, ry: number, rw: number, rh: number): Uint8Array {
  const arr = new Uint8Array(w * h)
  for (let y = ry; y < ry + rh; y++)
    for (let x = rx; x < rx + rw; x++)
      arr[y * w + x] = 1
  return arr
}

describe('findBestBlob', () => {
  it('returns null for all-dark frame', () => {
    expect(findBestBlob(new Uint8Array(100), 10, 10, 4, 400)).toBeNull()
  })

  it('detects a square blob and returns correct center', () => {
    // 3×3 blob at (3,3)–(5,5), center = (4,4)
    const blob = findBestBlob(makeRect(10, 10, 3, 3, 3, 3), 10, 10, 4, 400)
    expect(blob).not.toBeNull()
    expect(blob!.cx).toBe(4)
    expect(blob!.cy).toBe(4)
    expect(blob!.area).toBe(9)
  })

  it('rejects blob smaller than minBlobPixels', () => {
    // 2-pixel blob: area=2 < minPixels=4
    expect(findBestBlob(makeBright(10, 10, [[5,5],[6,5]]), 10, 10, 4, 400)).toBeNull()
  })

  it('rejects blob larger than maxBlobPixels', () => {
    // 5×5 = 25 pixels, maxPixels = 20
    expect(findBestBlob(makeRect(10, 10, 1, 1, 5, 5), 10, 10, 4, 20)).toBeNull()
  })

  it('rejects tall elongated blob (aspect < 0.5)', () => {
    // 1-wide × 8-tall: aspect = 0.125
    const pixels: [number,number][] = [[5,0],[5,1],[5,2],[5,3],[5,4],[5,5],[5,6],[5,7]]
    expect(findBestBlob(makeBright(10, 10, pixels), 10, 10, 4, 400)).toBeNull()
  })

  it('rejects wide elongated blob (aspect > 2)', () => {
    // 8-wide × 1-tall: aspect = 8
    const pixels: [number,number][] = [[0,5],[1,5],[2,5],[3,5],[4,5],[5,5],[6,5],[7,5]]
    expect(findBestBlob(makeBright(10, 10, pixels), 10, 10, 4, 400)).toBeNull()
  })

  it('returns a result when multiple candidates exist', () => {
    const arr = makeRect(15, 10, 0, 0, 3, 3)
    makeRect(15, 10, 6, 0, 3, 4).forEach((v, i) => { arr[i] = arr[i] | v })
    expect(findBestBlob(arr, 15, 10, 4, 400)).not.toBeNull()
  })
})

describe('BallDetector hysteresis', () => {
  const CFG = { brightnessThreshold: 30, minBlobPixels: 4, maxBlobPixels: 400, everyNthFrame: 2 }
  const BALL: import('./ballDetector.ts').BallPosition = { nx: 0.3, ny: 0.3, radius: 0.03 }

  it('does not fire before 3 consecutive frames', () => {
    const bd = new BallDetector(CFG)
    const cb = vi.fn()
    bd.onBallDetected(cb)
    bd._feedSyntheticPos(BALL)
    bd._feedSyntheticPos(BALL)
    expect(cb).not.toHaveBeenCalled()
  })

  it('fires onBallDetected after 3 consecutive frames', () => {
    const bd = new BallDetector(CFG)
    const positions: { nx: number; ny: number }[] = []
    bd.onBallDetected(pos => positions.push(pos))
    bd._feedSyntheticPos(BALL)
    bd._feedSyntheticPos(BALL)
    bd._feedSyntheticPos(BALL)
    expect(positions).toHaveLength(1)
    expect(positions[0].nx).toBeCloseTo(BALL.nx)
    expect(positions[0].ny).toBeCloseTo(BALL.ny)
  })

  it('resets consecutive count when a frame has no detection', () => {
    const bd = new BallDetector(CFG)
    const cb = vi.fn()
    bd.onBallDetected(cb)
    bd._feedSyntheticPos(BALL)
    bd._feedSyntheticPos(null)   // resets count
    bd._feedSyntheticPos(BALL)
    bd._feedSyntheticPos(BALL)
    expect(cb).not.toHaveBeenCalled()  // only 2 consecutive since reset
    bd._feedSyntheticPos(BALL)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('passes updated position on every frame after confirmation', () => {
    const bd = new BallDetector(CFG)
    const positions: { nx: number }[] = []
    bd.onBallDetected(pos => positions.push(pos))
    bd._feedSyntheticPos(BALL); bd._feedSyntheticPos(BALL); bd._feedSyntheticPos(BALL)
    expect(positions).toHaveLength(1)
    const moved = { nx: 0.5, ny: 0.5, radius: 0.03 }
    bd._feedSyntheticPos(moved)
    expect(positions).toHaveLength(2)
    expect(positions[1].nx).toBeCloseTo(0.5)
  })

  it('fires onBallLost after 5 consecutive empty frames', () => {
    const bd = new BallDetector(CFG)
    const lostCb = vi.fn()
    bd.onBallDetected(() => {})
    bd.onBallLost(lostCb)
    bd._feedSyntheticPos(BALL); bd._feedSyntheticPos(BALL); bd._feedSyntheticPos(BALL)
    for (let i = 0; i < 4; i++) bd._feedSyntheticPos(null)
    expect(lostCb).not.toHaveBeenCalled()
    bd._feedSyntheticPos(null)
    expect(lostCb).toHaveBeenCalledTimes(1)
  })

  it('does not fire onBallLost if ball was never confirmed', () => {
    const bd = new BallDetector(CFG)
    const lostCb = vi.fn()
    bd.onBallLost(lostCb)
    for (let i = 0; i < 10; i++) bd._feedSyntheticPos(null)
    expect(lostCb).not.toHaveBeenCalled()
  })

  it('allows re-detection after ball is lost', () => {
    const bd = new BallDetector(CFG)
    const detectedCb = vi.fn()
    const lostCb = vi.fn()
    bd.onBallDetected(detectedCb)
    bd.onBallLost(lostCb)
    // First detection
    bd._feedSyntheticPos(BALL); bd._feedSyntheticPos(BALL); bd._feedSyntheticPos(BALL)
    expect(detectedCb).toHaveBeenCalledTimes(1)
    // Lose it
    for (let i = 0; i < 5; i++) bd._feedSyntheticPos(null)
    expect(lostCb).toHaveBeenCalledTimes(1)
    // Re-detect — needs 3 fresh frames
    bd._feedSyntheticPos(BALL); bd._feedSyntheticPos(BALL); bd._feedSyntheticPos(BALL)
    expect(detectedCb).toHaveBeenCalledTimes(2)
  })
})
