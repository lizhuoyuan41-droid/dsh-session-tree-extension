/**
 * Scroll-anchoring guard for the inline branch-menu fold.
 *
 * Only the sidebar's real scroller is relevant. The plugin's own menus set
 * `overflow-x: hidden`, which computes `overflow-y` to `auto`; naively taking
 * the first ancestor with an auto overflow would therefore disable anchoring
 * on the menu itself and leave the sidebar free to pin rows below it.
 */

const BRANCH_HOST_SELECTOR = '[data-session-tree-branch-host]'

let releaseActive: (() => void) | null = null

/**
 * Find the nearest genuinely scrollable ancestor outside the plugin's portal.
 * @param element - any element inside the menu body.
 * @returns the sidebar scroller, or null when nothing actually scrolls.
 */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  if (typeof window === 'undefined') return null
  let node = element.parentElement
  while (node !== null) {
    // Menus (and their hosts) are excluded: their overflow is local clipping,
    // not the list scroller that owns the rows below.
    if (node.closest(BRANCH_HOST_SELECTOR) === null) {
      const overflowY = window.getComputedStyle(node).overflowY
      const scrollable = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
      if (scrollable && node.scrollHeight > node.clientHeight + 1) return node
    }
    node = node.parentElement
  }
  return null
}

/**
 * Disable scroll anchoring on the scroller containing `element` for one fold.
 * @param element - any element inside the menu body.
 * @param durationMs - expected transition time; anchoring is restored afterwards.
 */
export function holdScrollAnchorDuring(element: HTMLElement | null, durationMs: number): void {
  if (element === null) return
  const scroller = scrollerOf(element)
  if (scroller === null) return
  releaseActive?.()
  const previous = scroller.style.overflowAnchor
  scroller.style.overflowAnchor = 'none'
  const timer = window.setTimeout(() => {
    releaseActive = null
    scroller.style.overflowAnchor = previous
  }, durationMs + 60)
  releaseActive = () => {
    window.clearTimeout(timer)
    scroller.style.overflowAnchor = previous
    releaseActive = null
  }
}
