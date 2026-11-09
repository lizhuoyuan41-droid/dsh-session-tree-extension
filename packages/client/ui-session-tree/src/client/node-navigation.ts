/** Native turn containing this Session event seq, from `turn/start` events. */
export function nativeTurnForSeq(
  entries: readonly { type: string; event?: { type: string; seq: number; data?: unknown } }[],
  seq: number,
): number | undefined {
  let turn: number | undefined
  for (const entry of entries) {
    if (entry.type !== 'event' || entry.event === undefined) continue
    if (entry.event.seq > seq) continue
    if (entry.event.type !== 'turn/start') continue
    const value = (entry.event.data as { turn?: unknown } | undefined)?.turn
    if (typeof value === 'number') turn = value
  }
  return turn
}

interface RailView {
  nav: HTMLElement
  scroller: HTMLElement
  marks: HTMLButtonElement[]
}

function visible(element: Element): boolean {
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function turnOf(mark: HTMLButtonElement): number | null {
  const label = mark.getAttribute('aria-label') ?? ''
  const match = /\d+/u.exec(label)
  return match === null ? null : Number(match[0])
}

function railViews(root: HTMLElement, visibleOnly = false): RailView[] {
  const views: RailView[] = []
  for (const nav of root.querySelectorAll<HTMLElement>('nav')) {
    if (visibleOnly && !visible(nav)) continue
    const marks = [...nav.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
      .filter(mark => turnOf(mark) !== null)
    if (marks.length === 0) continue
    const scroller = nav.querySelector<HTMLElement>('[class*="scroller"]') ?? nav
    views.push({ nav, scroller, marks })
  }
  return views
}

/**
 * The transcript currently on screen. The conversation ancestor carries the
 * Session identity, so a retained hidden page with a matching rail can never
 * be mistaken for the target.
 */
export function visibleChatFlow(sessionId?: string): HTMLElement | null {
  if (typeof document === 'undefined') return null
  const roots = sessionId === undefined
    ? [document.body]
    : [...document.querySelectorAll<HTMLElement>('[data-conversation-session]')]
      .filter(root => root.dataset.conversationSession === sessionId && visible(root))
  for (const root of roots) {
    const flow = [...root.querySelectorAll<HTMLElement>('[data-chat-flow]')]
      .find(candidate => visible(candidate) && (candidate.textContent ?? '').trim().length > 0)
    if (flow !== undefined) return flow
  }
  return null
}

function scrollParentOf(flow: HTMLElement): HTMLElement | null {
  for (let node: HTMLElement | null = flow; node !== null && node !== document.body; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight + 4 && node.clientHeight > 0) return node
  }
  // Short conversations never overflow, so no ancestor passes the scrollable
  // check. The host still mounts the transcript inside
  // `[data-conversation-scroll]`, which spans the viewport and is the right
  // frame for the visibility test; falling back to the document keeps short
  // Sessions navigable instead of timing out as "page not displayed".
  const container = flow.closest<HTMLElement>('[data-conversation-scroll]')
  if (container !== null && visible(container)) return container
  return document.documentElement
}

/** Resolve the scroller and flow of the visible transcript. */
export function visibleTranscript(sessionId?: string): { flow: HTMLElement; scroller: HTMLElement } | null {
  const flow = visibleChatFlow(sessionId)
  if (flow === null) return null
  const scroller = scrollParentOf(flow)
  return scroller === null ? null : { flow, scroller }
}

function visibleTurnRow(flow: HTMLElement, turn: number): HTMLElement | null {
  const prefix = `${turn}:`
  const rows = [...flow.querySelectorAll<HTMLElement>('[data-chat-flow-key]')]
    .filter(row => (row.dataset.chatFlowKey ?? '').startsWith(prefix))
  return rows.find(row => visible(row)) ?? null
}

function activeTurns(root: HTMLElement): number[] {
  const turns: number[] = []
  for (const view of railViews(root, true)) {
    for (const mark of view.nav.querySelectorAll<HTMLButtonElement>('button[aria-current="true"]')) {
      const turn = turnOf(mark)
      if (turn !== null) turns.push(turn)
    }
  }
  return turns
}

function normally(value: string): string { return value.replace(/\s+/gu, ' ').trim() }

function landingMatches(root: HTMLElement, turn: number, sessionId?: string, expectText?: string): { ok: boolean; detail: string } {
  const transcript = visibleTranscript(sessionId)
  const active = activeTurns(root)
  if (transcript === null) return { ok: false, detail: '目标会话页面尚未显示' }
  const activeOk = active.length === 0 || active.includes(turn)
  // Prefer the clicked message itself, not just the rail's active number: the
  // rail can be re-rendered while the transcript still shows the restored A.
  const needle = expectText === undefined ? '' : normally(expectText)
  const wantsText = needle.length > 0 && !needle.includes('［图片］')
  let row: HTMLElement | null = null
  if (wantsText) {
    const scrollerRect = transcript.scroller.getBoundingClientRect()
    row = [...transcript.flow.querySelectorAll<HTMLElement>('[data-chat-flow-kind]')]
      .find(candidate => {
        if (!normally(candidate.textContent ?? '').includes(needle.slice(0, 80))) return false
        const rect = candidate.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
          && rect.bottom > scrollerRect.top + 4 && rect.top < scrollerRect.bottom - 4
      }) ?? null
    if (row === null) {
      return { ok: false, detail: `目标消息不在可视区域，激活轮次=${active.join(',') || '无'}` }
    }
  }
  if (row === null && !activeOk) return { ok: false, detail: `激活轮次=${active.join(',') || '无'}` }
  if (row === null && !active.includes(turn)) {
    return { ok: false, detail: `第 ${turn} 轮未激活，激活轮次=${active.join(',') || '无'}` }
  }
  return { ok: true, detail: wantsText ? '目标消息已显示' : `第 ${turn} 轮已激活` }
}

/** Wait until a target transcript is mounted and its restored scroll position settles. */
export function waitForVisiblePage(options: {
  signal?: AbortSignal | undefined
  sessionId?: string
  timeoutMs?: number
  quietMs?: number
} = {}): Promise<{ flow: HTMLElement; scroller: HTMLElement }> {
  const timeoutMs = options.timeoutMs ?? 10000
  const quietMs = options.quietMs ?? 160
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    let stableSince = 0
    let lastTop: number | null = null
    let lastFlow: HTMLElement | null = null
    let frame = 0
    let finished = false
    const cleanup = (): void => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      options.signal?.removeEventListener('abort', abort)
    }
    const abort = (): void => { finish(new DOMException('Navigation superseded', 'AbortError')) }
    const finish = (error?: Error): void => {
      if (finished) return
      finished = true
      cleanup()
      if (error === undefined) resolve({ flow: lastFlow!, scroller: scrollParentOf(lastFlow!)! })
      else reject(error)
    }
    const tick = (): void => {
      if (finished) return
      if (options.signal?.aborted) { abort(); return }
      const current = visibleTranscript(options.sessionId)
      const now = Date.now()
      if (current === null) {
        stableSince = 0
        lastTop = null
        lastFlow = null
      } else if (current.flow !== lastFlow || current.scroller.scrollTop !== lastTop) {
        lastFlow = current.flow
        lastTop = current.scroller.scrollTop
        stableSince = now
      } else if (stableSince !== 0 && now - stableSince >= quietMs) {
        finish()
        return
      }
      if (now >= deadline) { finish(new Error('目标会话页面未能在超时内完成初始化')); return }
      frame = window.requestAnimationFrame(tick)
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    tick()
  })
}

/** Scroll the rail so the target turn is mounted/visible, then return its mark. */
function revealMark(root: HTMLElement, turn: number, visibleOnly = false): HTMLButtonElement | null {
  for (const view of railViews(root, visibleOnly)) {
    const exact = view.marks.find(mark => mark.isConnected && turnOf(mark) === turn)
    if (exact !== undefined) return exact
    // A long transcript virtualizes the rail: only marks near scrollTop exist.
    // Move the scroller toward the target before giving up this attempt.
    const mounted = view.marks.map(mark => turnOf(mark)!).filter(value => Number.isFinite(value))
    if (mounted.length === 0) continue
    const min = Math.min(...mounted)
    const max = Math.max(...mounted)
    const range = Math.max(0, view.scroller.scrollHeight - view.scroller.clientHeight)
    if (turn > max) {
      view.scroller.scrollTop = range === 0 ? max * 10 : view.scroller.scrollHeight
    } else if (turn < min) {
      view.scroller.scrollTop = 0
    } else {
      const ratio = (turn - min) / Math.max(1, max - min)
      view.scroller.scrollTop = ratio * range
    }
  }
  return null
}

/** Keep the native turn rail scrolled with the transcript's vertical progress. */
export function attachRailScrollSync(): () => void {
  if (typeof document === 'undefined') return () => {}
  const onScroll = (event: Event): void => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (target.closest('[data-session-tree-panel]') !== null) return
    if (target.querySelector('[data-chat-flow]') === null) return
    if (target.scrollHeight <= target.clientHeight) return
    const rail = railViews(document.body, true)[0]
    if (rail === undefined) return
    const range = rail.scroller.scrollHeight - rail.scroller.clientHeight
    if (range <= 0) return
    const progress = target.scrollTop / Math.max(1, target.scrollHeight - target.clientHeight)
    rail.scroller.scrollTop = progress * range
  }
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  return () => { document.removeEventListener('scroll', onScroll, { capture: true }) }
}

/**
 * Activate the requested turn and, when `verify` is set, keep observing the
 * visible transcript until the target turn is actually on screen. Native page
 * initialization restores the previous reading position after the first
 * click, so a click alone is never treated as success.
 */
export function navigateNativeTurn({ turn, getRoot, signal, timeoutMs = 10000, verify = false, settleMs = 600, retryMs = 1400, maxClicks = 3, sessionId, expectText }: {
  turn: number
  getRoot: () => HTMLElement | null
  sessionId?: string
  signal?: AbortSignal | undefined
  timeoutMs?: number
  verify?: boolean
  settleMs?: number
  retryMs?: number
  maxClicks?: number
  expectText?: string
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let clickedAt = 0
    let clicks = 0
    let stableSince = 0
    let lastRailTop: number | null = null
    const observer = verify ? null : new MutationObserver(() => { attempt() })
    const cleanup = (): void => { observer?.disconnect(); window.clearTimeout(timer); window.clearInterval(retry); signal?.removeEventListener('abort', abort) }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error === undefined) resolve()
      else reject(error)
    }
    const abort = (): void => { finish(new DOMException('Navigation superseded', 'AbortError')) }
    const clickTarget = (): boolean => {
      const root = getRoot()
      if (root === null || !root.isConnected) return false
      const mark = revealMark(root, turn, verify)
      if (mark === null) return false
      if (!mark.isConnected || turnOf(mark) !== turn) return false
      try { mark.scrollIntoView?.({ block: 'center', inline: 'nearest' }) } catch { /* jsdom */ }
      mark.click()
      clickedAt = Date.now()
      clicks += 1
      stableSince = 0
      return true
    }
    const attempt = (): void => {
      try {
        attemptOnce()
      } catch (cause) {
        finish(cause instanceof Error ? cause : new Error(String(cause)))
      }
    }
    const attemptOnce = (): void => {
      if (signal?.aborted) { abort(); return }
      const root = getRoot()
      if (root === null || !root.isConnected) return
      if (!verify) {
        const railTop = railViews(root)[0]?.scroller.scrollTop ?? null
        if (railTop !== null && lastRailTop !== null && railTop !== lastRailTop) {
          lastRailTop = railTop
          return
        }
        lastRailTop = railTop
        if (clickTarget()) finish()
        return
      }
      // Judge the landing before touching the rail: the target may already be
      // visible, and single-turn Sessions render no rail at all
      // (`TurnNavigator` returns null for fewer than two items), where a
      // click-first flow could only time out.
      const landing = landingMatches(root, turn, sessionId, expectText)
      const now = Date.now()
      if (landing.ok) {
        if (stableSince === 0) stableSince = now
        if (now - stableSince >= settleMs) { finish(); return }
        return
      }
      stableSince = 0
      if (clicks === 0) {
        if (clickTarget()) return
        return
      }
      // The native page can finish restoring an older reading position after
      // our first click. Re-click once the page has had time to settle, but
      // never thrash the rail indefinitely.
      if (now - clickedAt >= retryMs) {
        if (clicks >= maxClicks) {
          finish(new Error(`跳转未落到第 ${turn} 轮：${landing.detail}`))
          return
        }
        clickTarget()
      }
    }
    const timer = window.setTimeout(() => {
      if (!verify) { finish(new Error(`无法定位第 ${turn} 轮：目标会话的轮次导航尚未就绪`)); return }
      try {
        const root = getRoot()
        const detail = root === null ? '目标会话页面未显示' : landingMatches(root, turn, sessionId, expectText).detail
        finish(new Error(`跳转未落到第 ${turn} 轮：${detail}`))
      } catch (cause) {
        finish(cause instanceof Error ? cause : new Error(String(cause)))
      }
    }, timeoutMs)
    const retry = window.setInterval(attempt, verify ? 60 : 80)
    if (observer !== null) observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] })
    signal?.addEventListener('abort', abort, { once: true })
    attempt()
  })
}
