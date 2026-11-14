/** Keep workspace-toggle motion based on the layout BEFORE the user action. */
const HOST = '[data-session-tree-branch-host]'
const ROW = '[data-row-key]'
const HEADER = '[data-row-key^="workspace:"][aria-expanded]'

interface Position { left: number; top: number }

/** Read only visible native rows. Hidden rows have no meaningful origin. */
function positions(tree: HTMLElement): Map<string, Position> {
  const result = new Map<string, Position>()
  for (const row of tree.querySelectorAll<HTMLElement>(ROW)) {
    if (row.closest(HOST) !== null) continue
    const box = row.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) continue
    result.set(row.dataset.rowKey!, { left: box.left, top: box.top })
  }
  return result
}

/** Cancel native FLIP translations only; preserve status/opacity animations. */
function cancelTranslations(row: HTMLElement): void {
  for (const animation of row.getAnimations?.() ?? []) {
    const effect = animation.effect as KeyframeEffect | null
    if (effect?.target !== row || typeof effect.getKeyframes !== 'function') continue
    if (effect.getKeyframes().some(frame => frame.transform !== undefined)) animation.cancel()
  }
}

/**
 * Snapshot before React handles a workspace toggle. The next animation frame
 * runs after the native commit and the branch portals' layout effects. Never
 * use a transformed post-commit rectangle as the old position: that preserves
 * precisely the stale translation we are trying to replace.
 */
export function installWorkspaceMotion(doc: Document): () => void {
  const win = doc.defaultView
  if (win === null || typeof win.requestAnimationFrame !== 'function') return () => {}
  let frame = 0
  let observer: MutationObserver | null = null
  const owned = new Set<Animation>()
  const capture = (event: Event): void => {
    const target = event.target as Element | null
    if (target === null || typeof target.closest !== 'function') return
    if (event instanceof win.KeyboardEvent && !['Enter', ' ', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
    if (target.closest('button, a, input, textarea, [contenteditable]') !== null) return
    const header = target.closest<HTMLElement>(HEADER)
    const tree = header?.closest<HTMLElement>('[role="tree"]')
    if (header === null || header === undefined || tree === null || tree === undefined) return
    const before = positions(tree)
    const expanded = header.getAttribute('aria-expanded')
    const scrollTop = tree.scrollTop
    if (frame !== 0) win.cancelAnimationFrame(frame)
    observer?.disconnect()
    // Native animations start in componentDidUpdate. Strip stale translations
    // from entrants in the mutation microtask, before the first paint, even if
    // React defers mounting a branch portal beyond this frame.
    observer = new win.MutationObserver(() => {
      if (header.getAttribute('aria-expanded') === expanded) return
      for (const row of tree.querySelectorAll<HTMLElement>(ROW)) {
        if (row.closest(HOST) === null && !before.has(row.dataset.rowKey!)) cancelTranslations(row)
      }
    })
    observer.observe(tree, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })
    frame = win.requestAnimationFrame(() => {
      frame = 0
      observer?.disconnect()
      observer = null
      if (!header.isConnected || header.getAttribute('aria-expanded') === expanded) return
      const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
      // Cancel all translations first, then read all final positions. This also
      // handles native workspace headers and overflow buttons below the menu.
      const rows = [...tree.querySelectorAll<HTMLElement>(ROW)].filter(row => row.closest(HOST) === null)
      for (const row of rows) cancelTranslations(row)
      for (const animation of owned) animation.cancel()
      owned.clear()
      const after = positions(tree)
      const scrollDelta = scrollTop - tree.scrollTop
      if (reduced) return
      for (const row of rows) {
        const key = row.dataset.rowKey!
        const end = after.get(key)
        if (end === undefined || typeof row.animate !== 'function') continue
        const start = before.get(key)
        let keyframes: Keyframe[]
        let duration: number
        if (start === undefined) {
          // New sessions have no old screen coordinate. Fade at the final
          // position, matching native entry behavior; never translate from 0.
          keyframes = [{ opacity: 0 }, { opacity: 1 }]
          duration = 100
        } else {
          const dx = start.left - end.left
          const dy = start.top + scrollDelta - end.top
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
          keyframes = [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }]
          duration = 200
        }
        const animation = row.animate(keyframes, { duration, easing: 'ease-out' })
        owned.add(animation)
        animation.onfinish = () => { owned.delete(animation) }
      }
    })
  }
  doc.addEventListener('click', capture, true)
  doc.addEventListener('keydown', capture, true)
  return () => {
    doc.removeEventListener('click', capture, true)
    doc.removeEventListener('keydown', capture, true)
    observer?.disconnect()
    observer = null
    if (frame !== 0) win.cancelAnimationFrame(frame)
    for (const animation of owned) animation.cancel()
    owned.clear()
  }
}
