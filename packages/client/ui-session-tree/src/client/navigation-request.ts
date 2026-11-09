/**
 * One navigation request at a time, owned outside React. A click that triggers
 * a Session switch must survive the source panel's remount, abort older
 * requests, and publish a confirmed selection only after the target page has
 * actually landed.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TreeNode } from '@robiteame/dsh-pi-agent-session-tree/client'
import { beginNavigation, failNavigation, finishNavigation, rememberSelection } from './navigation-store.ts'

export interface NodeNavigationRequest {
  readonly sessionId: SessionId
  readonly nodeId: string
  readonly node: TreeNode
  readonly switchSession: boolean
  /** Visible text of the clicked message, used to verify the landing. */
  readonly expectText?: string
}

export interface NodeNavigationActions {
  /** Reveal/activate the target Session before any turn positioning. */
  readonly openSession: (sessionId: SessionId) => void
  /** Resolve/load the target turn before the page switches. */
  readonly prepare?: (sessionId: SessionId, node: TreeNode, signal: AbortSignal) => Promise<{ turn: number }>
  /** Wait for the visible target page, then position and verify the turn. */
  readonly navigate: (sessionId: SessionId, node: TreeNode, signal: AbortSignal, options: {
    readonly expectCurrentSession: boolean
    readonly expectText?: string
    readonly plan?: { turn: number }
  }) => Promise<void>
  /** Persist the confirmed target cursor on its own Session. */
  readonly persist: (nodeId: string) => Promise<void>
}

let sequence = 0
let active: AbortController | null = null
const done = new Set<number>()

export function requestNodeNavigation(
  request: NodeNavigationRequest,
  actions: NodeNavigationActions,
): Promise<void> {
  const requestId = ++sequence
  active?.abort()
  const controller = new AbortController()
  active = controller
  beginNavigation(requestId)
  return (async () => {
    try {
      // Load the target history while the previous page is still visible.
      const plan = actions.prepare === undefined
        ? undefined
        : await actions.prepare(request.sessionId, request.node, controller.signal)
      if (controller.signal.aborted || requestId !== sequence) return
      if (request.switchSession) actions.openSession(request.sessionId)
      await actions.navigate(request.sessionId, request.node, controller.signal, {
        ...(plan === undefined ? {} : { plan }),
        expectCurrentSession: request.switchSession,
        ...(request.expectText === undefined ? {} : { expectText: request.expectText }),
      })
      if (controller.signal.aborted || requestId !== sequence) return
      // The landing is already verified: show the confirmed row immediately.
      // The cursor write is durable bookkeeping and must not delay the tree.
      rememberSelection(request.sessionId, request.nodeId)
      done.add(requestId)
      finishNavigation(requestId)
      // The landing is already confirmed and the row is selected. A failed
      // durable cursor write must not flip the panel into an error state; the
      // next tree sync retries the write from the remembered selection.
      try {
        await actions.persist(request.nodeId)
      } catch {
        // Best-effort bookkeeping only.
      }
    } catch (cause) {
      if (controller.signal.aborted || requestId !== sequence) return
      const message = cause instanceof Error ? cause.message : String(cause)
      failNavigation(requestId, message)
    }
  })()
}

/** Test/diagnostic face: whether one request reached the confirmed state. */
export function navigationCompleted(requestId: number): boolean { return done.has(requestId) }
export function currentNavigationRequest(): number { return sequence }

/** Test-only: forget in-flight requests and completion bookkeeping. */
export function resetNavigationRequestsForTests(): void {
  active?.abort()
  active = null
  sequence = 0
  done.clear()
}
