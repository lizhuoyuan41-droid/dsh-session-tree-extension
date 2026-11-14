/**
 * Scroll-anchoring guard for the inline branch-menu fold.
 *
 * The native session list lives inside a scrolling sidebar. While a tall menu
 * changes height, the browser's scroll anchoring may pin a row below the menu
 * (or above it), so the list appears to move on a different timeline than the
 * menu. Disable anchoring on the surrounding scroller for the fold only, then
 * restore the previous inline value.
 */

let releaseActive: (() => void) | null = null

/** Find the nearest vertically scrolling ancestor. */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  if (typeof window === 'undefined') return null
  let node = element.parentElement
  while (node !== null) {
    const overflowY = window.getComputedStyle(node).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return node
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
