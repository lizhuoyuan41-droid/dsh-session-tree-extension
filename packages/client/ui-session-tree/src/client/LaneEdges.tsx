import { useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'
import type { SessionGraphRow } from './session-graph.ts'
import css from './SessionTreePanel.module.css'

interface CirclePosition { x: number; y: number; radius: number; bottom: number }
interface Edge { key: string; parent: string; child: string; path: string; color: string }

/** Work in measured CSS pixels: both endpoint tangents are vertical. */
export function laneEdgePath(
  parent: Pick<CirclePosition, 'x' | 'y' | 'radius'>,
  child: Pick<CirclePosition, 'x' | 'y' | 'radius'>,
  laneDistance = Math.max(1, Math.round(Math.abs(child.x - parent.x) / 15)),
  maxTransition = Number.POSITIVE_INFINITY,
  stagger = 0,
): string {
  const start = parent.y + parent.radius + stagger
  const end = child.y - child.radius
  if (parent.x === child.x) return `M ${parent.x} ${start} V ${end}`
  // A branch that crosses more lanes gets a proportionally longer transition:
  // the inner fork turns early, the outer fork keeps the S gentle.
  const span = Math.abs(child.x - parent.x)
  const target = Math.max(32, span * 2 * Math.max(1, laneDistance))
  // Finish the horizontal move inside the fork row and stagger sibling edges.
  // A long S continuing through later rows would slice across the branches
  // nested between this lane and the parent.
  const curveHeight = Math.min(target, Math.max(0, end - start), Math.max(0, maxTransition))
  const controlY = start + curveHeight / 2
  return `M ${parent.x} ${start} C ${parent.x} ${controlY} ${child.x} ${controlY} ${child.x} ${start + curveHeight} V ${end}`
}

/** One SVG owns the actual graph edges; rows only own their circle markers. */
export function LaneEdges({ container, rows, allRows = rows, colors }: {
  container: RefObject<HTMLDivElement>
  rows: readonly SessionGraphRow[]
  allRows?: readonly SessionGraphRow[]
  colors: readonly string[]
}) {
  const [drawing, setDrawing] = useState<{ height: number; width: number; edges: Edge[] }>({ height: 0, width: 0, edges: [] })
  useLayoutEffect(() => {
    const root = container.current
    if (root === null) return
    const measure = (): void => {
      const rootRect = root.getBoundingClientRect()
      const positions = new Map<string, CirclePosition>()
      for (const element of root.querySelectorAll<HTMLElement>('[data-session-tree-row]')) {
        const marker = element.querySelector<SVGSVGElement>('svg[data-node-marker]')
        if (marker === null) continue
        const rect = marker.getBoundingClientRect()
        const rowRect = element.getBoundingClientRect()
        positions.set(element.dataset.sessionTreeRow!, {
          x: rect.left + rect.width / 2 - rootRect.left + root.scrollLeft,
          y: rect.top + rect.height / 2 - rootRect.top + root.scrollTop,
          radius: rect.width / 2,
          bottom: rowRect.bottom - rootRect.top + root.scrollTop,
        })
      }
      const rowByKey = new Map(allRows.map(row => [row.key, row]))
      const edges: Edge[] = []
      for (const row of rows) {
        if (row.parentKey === null) continue
        let parentKey: string | null = row.parentKey
        const seen = new Set<string>()
        // Collapsed rows reconnect to the closest visible ancestor.
        while (parentKey !== null && !positions.has(parentKey) && !seen.has(parentKey)) {
          seen.add(parentKey)
          parentKey = rowByKey.get(parentKey)?.parentKey ?? null
        }
        const parent = parentKey === null ? undefined : positions.get(parentKey)
        const child = positions.get(row.key)
        if (parent === undefined || child === undefined || child.y <= parent.y) continue
        const parentRow = rowByKey.get(parentKey!)
        const laneDistance = Math.max(1, Math.abs(row.lane - (parentRow?.lane ?? row.lane)))
        // Sibling edges leave the same fork point and must finish their lane
        // change inside that row. A longer S would run alongside, and cut
        // across, the branches nested between this lane and the parent.
        const maxTransition = parent.bottom - (parent.y + parent.radius) - 2
        edges.push({
          key: row.key, parent: parentKey!, child: row.key,
          path: laneEdgePath(parent, child, laneDistance, maxTransition),
          color: colors[row.colorIndex % colors.length]!,
        })
      }
      const next = { height: root.scrollHeight, width: root.clientWidth, edges }
      setDrawing(current => JSON.stringify(current) === JSON.stringify(next) ? current : next)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    for (const element of root.querySelectorAll('[data-session-tree-row]')) observer.observe(element)
    return () => { observer.disconnect() }
  }, [container, rows, allRows, colors])
  return <svg className={css.laneEdges} width={drawing.width} height={drawing.height} aria-hidden="true" data-lane-edges>
    {drawing.edges.map(edge => <path key={edge.key} data-parent-key={edge.parent} data-child-key={edge.child}
      d={edge.path} fill="none" stroke={edge.color} strokeWidth="1.5" strokeLinecap="round" />)}
  </svg>
}
