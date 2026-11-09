/**
 * Plugin-owned durable sidecar for SessionTree projections.
 *
 * The stock DeepSeek-Harness session log does not recognize `session-tree/*`
 * events, so branch names, cursor, selection, and explicit snapshot state
 * cannot live inside `session.jsonl.zstd` without patching the harness. This
 * module keeps one small JSON artifact per session under the DSH home instead
 * and replays only native events after the stored watermark on resume.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionTree } from './session-tree.ts'
import type { SessionTreeSnapshot } from './types.ts'

/**
 * Sidecar format version.
 * - 1 — initial projection cache.
 * - 2 — user-message nodes carry `metadata.injected` for harness-injected
 *   context (skill prompts, system-prompt snapshots). Older caches hold
 *   unmarked injected nodes, so they fail validation and the tree re-projects
 *   deterministically from the native Session log.
 * - 3 — image parts pass replay validation and retain their attachment identity.
 *   Prior caches may have a current watermark despite missing historical image
 *   nodes, so invalidate them and rebuild from the native log.
 */
const SIDECAR_VERSION = 3

/** One sidecar artifact: versioned ownership plus the latest tree snapshot. */
interface SessionTreeSidecarRecord {
  readonly version: typeof SIDECAR_VERSION
  readonly sessionId: string
  readonly savedAt: number
  readonly snapshot: SessionTreeSnapshot
}

/**
 * Resolve the DSH home the same way the Harness does: an explicit `DSH_HOME`
 * wins, otherwise the default `<user home>/.dsh`. Falling back to the bare user
 * home put the sidecar outside the DSH directory on launchers (like the
 * desktop host) that do not export `DSH_HOME`, splitting one session's state
 * between `~/storages/session-tree` and `~/.dsh/storages/session-tree`.
 */
export function defaultSidecarRoot(): string {
  const configured = process.env.DSH_HOME
  const home = configured !== undefined && configured.trim() !== '' ? configured : join(homedir(), '.dsh')
  return join(home, 'storages', 'session-tree')
}

/** Make a session id safe as a filename without losing its diagnostic shape. */
function sidecarFilename(sessionId: SessionId): string {
  return `${sessionId.replaceAll(/[^A-Za-z0-9._-]/g, '_')}.json`
}

/** Synchronous sidecar store used by host-only session-tree plugins. */
export class SessionTreeSidecar {
  constructor(readonly root: string = defaultSidecarRoot()) {}

  /** Read and validate the latest snapshot for one session. */
  load(sessionId: SessionId): SessionTree | undefined {
    const path = join(this.root, sidecarFilename(sessionId))
    if (!existsSync(path)) return undefined
    try {
      const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<SessionTreeSidecarRecord>
      if (record.version !== SIDECAR_VERSION
        || record.sessionId !== sessionId
        || typeof record.savedAt !== 'number'
        || record.snapshot === undefined) {
        return undefined
      }
      return new SessionTree(sessionId, record.snapshot)
    } catch {
      return undefined
    }
  }

  /**
   * Move a stale or corrupt projection aside. Renaming keeps the bytes for
   * diagnostics while the next sync rebuilds from the native log; deleting the
   * file here would destroy the only copy of non-rebuildable cursor/branch
   * metadata before the caller decides it is unusable.
   */
  discard(sessionId: SessionId): void {
    const path = join(this.root, sidecarFilename(sessionId))
    if (!existsSync(path)) return
    try {
      renameSync(path, `${path}.invalid-${Date.now().toString(36)}`)
    } catch {
      // Best effort: a failed rename only costs one more rebuild attempt.
    }
  }

  /**
   * Atomically persist one tree. I/O errors are deliberately contained:
   * the native Session log remains the source of truth and can rebuild a
   * linear projection even when the sidecar directory is unavailable.
   */
  save(sessionId: SessionId, tree: SessionTree): boolean {
    const record: SessionTreeSidecarRecord = {
      version: SIDECAR_VERSION,
      sessionId,
      savedAt: Date.now(),
      snapshot: tree.snapshot(),
    }
    const path = join(this.root, sidecarFilename(sessionId))
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, path)
      return true
    } catch {
      try { rmSync(temporary, { force: true }) } catch { /* best effort cleanup */ }
      return false
    }
  }
}

/**
 * Trees above this node count are persisted on a coalescing timer: serializing
 * a large tree (full message text) on the click path blocks the host loop and
 * shows up as a UI flash. Small trees stay synchronous so callers and tests can
 * read the sidecar immediately after an operation.
 */
const SYNC_SAVE_NODE_LIMIT = 200
const pendingTrees = new Map<string, SessionTree>()
/** Last revision written per tree; unchanged projections never rewrite JSON. */
const savedRevision = new WeakMap<SessionTree, number>()
let pendingTimer: ReturnType<typeof setTimeout> | undefined

/** Process-wide sidecar selected by the Host Bundle or a test. */
let activeSidecar = new SessionTreeSidecar()

export function getSessionTreeSidecar(): SessionTreeSidecar {
  return activeSidecar
}

/** Replace the active sidecar, primarily for isolated tests. */
export function setSessionTreeSidecar(sidecar: SessionTreeSidecar): void {
  flushSessionTreeSidecar()
  activeSidecar = sidecar
}

/** Persist one tree without coupling callers to the active store selection. */
export function persistSessionTree(tree: SessionTree): boolean {
  // Reading the panel or walking an unchanged step must not rewrite the whole
  // snapshot: serialization is the expensive part of the click path.
  if (savedRevision.get(tree) === tree.revision) return true
  if (tree.size <= SYNC_SAVE_NODE_LIMIT) {
    pendingTrees.delete(tree.sessionId)
    const saved = activeSidecar.save(tree.sessionId, tree)
    if (saved) savedRevision.set(tree, tree.revision)
    return saved
  }
  pendingTrees.set(tree.sessionId, tree)
  if (pendingTimer === undefined) {
    pendingTimer = setTimeout(flushSessionTreeSidecar, 400)
    pendingTimer.unref?.()
  }
  return true
}

/** Write every coalesced tree now (session flush / shutdown / test hooks). */
export function flushSessionTreeSidecar(): void {
  if (pendingTimer !== undefined) {
    clearTimeout(pendingTimer)
    pendingTimer = undefined
  }
  if (pendingTrees.size === 0) return
  const trees = [...pendingTrees.values()]
  pendingTrees.clear()
  for (const tree of trees) {
    if (savedRevision.get(tree) === tree.revision) continue
    if (activeSidecar.save(tree.sessionId, tree)) savedRevision.set(tree, tree.revision)
  }
}
