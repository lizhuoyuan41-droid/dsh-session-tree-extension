/**
 * Page-process lifetime for inline branch-menu expansion.
 *
 * The store deliberately lives in module scope instead of component state:
 * collapsing a workspace unmounts the native rows (and this portal), but the
 * user's opened menus must survive that remount. A host start or page reload
 * loads a fresh module and therefore restores the default (all collapsed).
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const openMenus = new Set<SessionId>()
let snapshot: ReadonlySet<SessionId> = new Set()
const listeners = new Set<() => void>()

function publish(): void {
  snapshot = new Set(openMenus)
  for (const listener of listeners) listener()
}

/** Subscribe to expansion changes; returns the unsubscribe function. */
export function subscribeBranchMenus(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Current expanded menu sources; stable between changes. */
export function branchMenusSnapshot(): ReadonlySet<SessionId> {
  return snapshot
}

/** Flip one source menu between expanded and collapsed. */
export function toggleBranchMenu(sessionId: SessionId): void {
  if (openMenus.has(sessionId)) openMenus.delete(sessionId)
  else openMenus.add(sessionId)
  publish()
}

/**
 * Fold duration for one menu: long content keeps a readable speed, bounded so
 * a huge menu cannot take seconds to settle.
 * @param contentHeight - measured content height in pixels.
 * @returns transition duration in milliseconds.
 */
export function branchMenuDuration(contentHeight: number): number {
  return Math.min(600, Math.max(200, Math.round(200 + contentHeight * 0.4)))
}

/** Drop every remembered expansion (tests and full page teardown only). */
export function resetBranchMenus(): void {
  openMenus.clear()
  publish()
}
