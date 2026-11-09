/**
 * Remembered subtree focus for the session-tree panel.
 *
 * The right sidebar is mounted and unmounted as Sessions switch. Keeping the
 * focus root in component state resets it to the whole tree on every remount;
 * this small store persists one root per browser tab so navigating inside the
 * focused subtree and reopening the sidebar restore the same view.
 */
const STORAGE_KEY = 'session-tree.focus.v1'
const listeners = new Set<() => void>()

function read(): string | null {
  try {
    if (typeof sessionStorage === 'undefined') return null
    const value = sessionStorage.getItem(STORAGE_KEY)
    return value === null || value === '' ? null : value
  } catch {
    return null
  }
}

let current: string | null = read()

export function focusKeySnapshot(): string | null {
  return current
}

export function subscribeFocusKey(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function setFocusKey(key: string | null): void {
  if (current === key) return
  current = key
  try {
    if (typeof sessionStorage !== 'undefined') {
      if (key === null) sessionStorage.removeItem(STORAGE_KEY)
      else sessionStorage.setItem(STORAGE_KEY, key)
    }
  } catch {
    // Focus is a convenience; storage failures must not break the panel.
  }
  for (const listener of listeners) listener()
}

/** Test-only: drop both memory and tab storage between specs. */
export function resetFocusKeyForTests(): void {
  current = null
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
  for (const listener of listeners) listener()
}
