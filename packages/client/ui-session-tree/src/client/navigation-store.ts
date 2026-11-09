/**
 * Cross-panel navigation state. A click can outlive the tree panel that
 * started it (a Session switch remounts the right Sidebar), so the pending
 * request, its status and the confirmed selection live at module scope.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export interface NavigationStatus {
  /** Monotonic request identity; only the newest request may publish. */
  readonly requestId: number
  readonly pending: boolean
  readonly error: string | null
}

const IDLE: NavigationStatus = { requestId: 0, pending: false, error: null }

type Listener = () => void
const statusListeners = new Set<Listener>()
const selectionListeners = new Set<Listener>()

let status: NavigationStatus = IDLE
let selection: ReadonlyMap<SessionId, string> = new Map()

export function navigationStatus(): NavigationStatus { return status }
export function subscribeNavigationStatus(listener: Listener): () => void {
  statusListeners.add(listener)
  return () => { statusListeners.delete(listener) }
}

function publish(next: NavigationStatus): void {
  if (next.requestId === status.requestId && next.pending === status.pending && next.error === status.error) return
  status = next
  for (const listener of statusListeners) listener()
}

export function beginNavigation(requestId: number): void {
  publish({ requestId, pending: true, error: null })
}

export function finishNavigation(requestId: number): void {
  if (requestId !== status.requestId) return
  publish({ requestId, pending: false, error: null })
}

export function failNavigation(requestId: number, error: string): void {
  if (requestId !== status.requestId) return
  publish({ requestId, pending: false, error })
}

/** Selection confirmed only after the native page landed on the target turn. */
export function rememberedSelection(): ReadonlyMap<SessionId, string> { return selection }
export function subscribeSelection(listener: Listener): () => void {
  selectionListeners.add(listener)
  return () => { selectionListeners.delete(listener) }
}
export function rememberSelection(sessionId: SessionId, nodeId: string): void {
  if (selection.get(sessionId) === nodeId) return
  const next = new Map(selection)
  next.set(sessionId, nodeId)
  selection = next
  for (const listener of selectionListeners) listener()
}

/** Test-only: clear module-scoped navigation state between specs. */
export function resetNavigationStateForTests(): void {
  status = IDLE
  selection = new Map()
  for (const listener of statusListeners) listener()
  for (const listener of selectionListeners) listener()
}
