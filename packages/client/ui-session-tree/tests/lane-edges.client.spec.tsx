import { describe, expect, it } from 'vitest'
import { laneEdgePath } from '../src/client/LaneEdges.tsx'

describe('measured timeline edges', () => {
  // Oracle: each real parent-child edge must meet the actual circle boundaries,
  // keep vertical endpoint tangents, and never depend on the row's CSS height.
  it('connects the parent circle bottom to the child circle top', () => {
    expect(laneEdgePath({ x: 14, y: 40, radius: 6.5 }, { x: 59, y: 500, radius: 8.5 }))
      .toBe('M 14 46.5 C 14 181.5 59 181.5 59 316.5 V 491.5')
  })
  it('uses only a continuous vertical line within one branch', () => {
    expect(laneEdgePath({ x: 14, y: 40, radius: 6.5 }, { x: 14, y: 100, radius: 6.5 }))
      .toBe('M 14 46.5 V 93.5')
  })
  it('makes a wider lane transition gentler than an inner one', () => {
    const parent = { x: 14, y: 40, radius: 6.5 }
    const inner = laneEdgePath(parent, { x: 29, y: 500, radius: 6.5 }, 1)
    const outer = laneEdgePath(parent, { x: 44, y: 500, radius: 6.5 }, 2)
    const heightOf = (path: string): number => {
      const match = /C \S+ (\S+) /u.exec(path)
      return Number(match?.[1] ?? 0) - 46.5
    }
    expect(heightOf(outer)).toBeGreaterThan(heightOf(inner) * 1.5)
  })
  it('fits a smooth cubic into the available distance for adjacent rows', () => {
    expect(laneEdgePath({ x: 14, y: 40, radius: 6.5 }, { x: 44, y: 90, radius: 6.5 }))
      .toBe('M 14 46.5 C 14 65 44 65 44 83.5 V 83.5')
  })
})

describe('fork transition routing', () => {
  it('finishes the lane change inside the fork row so it cannot cut through an inner branch', () => {
    const parent = { x: 14, y: 40, radius: 6.5 }
    const child = { x: 44, y: 500, radius: 6.5 }
    const path = laneEdgePath(parent, child, 2, 40, 6)
    const numbers = (path.match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number)
    // M x y C c1x c1y c2x c2y x2 y2 V y3
    const curveEnd = numbers[7]
    expect(curveEnd).toBeLessThanOrEqual(40 + 6.5 + 6 + 40 + 0.001)
  })

  it('nests sibling transitions so the outer curve is always right of the inner one', () => {
    const parent = { x: 14, y: 40, radius: 6.5 }
    const limited = (x: number): string => laneEdgePath(parent, { x, y: 500, radius: 6.5 }, (x - 14) / 15, 40)
    const inner = limited(29)
    const outer = limited(44)
    expect(inner.startsWith('M 14 46.5')).toBe(true)
    expect(outer.startsWith('M 14 46.5')).toBe(true)
    const points = (path: string): number[] => (path.match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number)
    // At the shared control height the outer curve is further right.
    expect(points(outer)[4]).toBeGreaterThan(points(inner)[4])
  })
})
