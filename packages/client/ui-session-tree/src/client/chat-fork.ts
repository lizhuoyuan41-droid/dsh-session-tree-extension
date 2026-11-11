import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionTreeView, TreeNode } from '@ryanlee2007/dsh-pi-agent-session-tree/client'

interface NativeEntry {
  readonly type: string
  readonly event?: { readonly type: string; readonly seq: number; readonly data?: unknown }
}

/** Resolve using native boundaries: legacy sidecars have no turn metadata. */
export function forkNodeForTurn(view: SessionTreeView, entries: readonly NativeEntry[], turn: number): TreeNode {
  const events = entries.flatMap(entry => entry.type === 'event' && entry.event !== undefined ? [entry.event] : [])
    .sort((a, b) => a.seq - b.seq)
  const start = events.find(event => event.type === 'turn/start'
    && (event.data as { turn?: unknown } | undefined)?.turn === turn)
  const nextStart = start === undefined ? undefined : events.find(event => event.type === 'turn/start' && event.seq > start.seq)
  const end = start === undefined ? undefined : events.find(event => event.type === 'turn/end'
    && event.seq > start.seq && (nextStart === undefined || event.seq < nextStart.seq))
  if (start === undefined || end === undefined) {
    throw new Error('该轮次尚未完成或缺少轮次记录，无法分叉')
  }
  const prompt = view.nodes.filter(node => {
    const seq = node.metadata?.sessionEventSeq
    // Match forkSession's eligibility exactly. Text prefixes can be typed by
    // a human and are only display heuristics, not an injection identity.
    return node.message?.role === 'user' && node.metadata?.injected !== true
      && typeof seq === 'number' && seq > start.seq && seq < end.seq
  }).sort((a, b) => Number(a.metadata?.sessionEventSeq) - Number(b.metadata?.sessionEventSeq)).at(-1)
  if (prompt === undefined) throw new Error('该轮次没有可分叉的用户消息')
  return prompt
}

/**
 * Compatibility bridge for Harness 0.2.2's footer, which has no action override
 * slot. Use native semantic DOM markers and the current translated label;
 * retain its permission/unavailable behavior and remove the bridge on unload.
 */
export function installChatForkBridge(
  root: Document,
  branchLabel: () => string,
  fork: (sessionId: SessionId, turn: number) => Promise<void>,
): () => void {
  const pending = new Set<string>()
  const errors = new Set<HTMLElement>()
  let disposed = false
  const click = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return
    const button = event.target.closest<HTMLButtonElement>('button[aria-label]')
    if (button === null || button.getAttribute('aria-label') !== branchLabel()) return
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return
    const actions = button.closest('[data-clock="end"]')
    const tail = actions?.closest<HTMLElement>('[data-turn-tail]')
    const sessionId = tail?.closest<HTMLElement>('[data-conversation-session]')?.dataset.conversationSession
    const turnText = tail?.dataset.turnTail
    if (tail === undefined || tail === null || !sessionId || !turnText || !/^\d+$/u.test(turnText)) return
    const turn = Number(turnText)
    if (!Number.isSafeInteger(turn)) return
    // Intercept before React's delegated handler can create a native fork.
    event.preventDefault()
    event.stopImmediatePropagation()
    if (pending.has(sessionId)) return
    pending.add(sessionId)
    for (const error of errors) error.remove()
    errors.clear()
    void Promise.resolve().then(() => {
      if (!disposed) return fork(sessionId as SessionId, turn)
    }).catch(cause => {
      if (disposed) return
      const error = root.createElement('p')
      error.setAttribute('role', 'alert')
      error.dataset.sessionTreeForkError = ''
      const message = cause instanceof Error ? cause.message : String(cause)
      error.textContent = message.includes('STALE_FORK_POINT')
        ? '会话树仅支持从最新用户轮次分叉，请使用最新轮次的分支按钮。'
        : `分叉失败：${message}`
      // If a Session switch detached the source, keep the failure visible.
      ;(tail.isConnected ? tail : root.body).append(error)
      errors.add(error)
    }).finally(() => { pending.delete(sessionId) })
  }
  root.addEventListener('click', click, true)
  return () => {
    disposed = true
    root.removeEventListener('click', click, true)
    for (const error of errors) error.remove()
    errors.clear()
  }
}
