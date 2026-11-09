/**
 * Session-tree domain service: the append-only multi-branch conversation
 * tree, one per agent session, served to the browser through the generated
 * `sessionTree` Remote namespace.
 *
 * Design notes
 * - A process-wide store keeps every session's tree; the companion
 *   `@robiteame/dsh-tool-session-tree` plugin shares the same store, so
 *   anything the model appends is immediately visible to the browser panel
 *   and vice versa.
 * - Harness Session events are the durable source of truth; the process-wide
 *   store is an incrementally synchronized projection, while explicit snapshots
 *   remain available for export and full-tree restore.
 * - Every operation answers `{ok, value}|{ok:false,error}` from the domain
 *   layer; the Remote boundary adds its own transport envelope.
 *
 * @module @robiteame/dsh-pi-agent-session-tree
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId as toSessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Session } from '@deepseek-ai/dsh-session'
import { isSurfaceEvent } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session/types'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { SessionTree, sessionTreeStore } from './session-tree.ts'
import { attachToolResult, isInjectedUserNode, sessionEventsToTreeNodes, toolResultOf } from './session-event-adapter.ts'
import { flushSessionTreeSidecar, getSessionTreeSidecar, persistSessionTree } from './session-tree-sidecar.ts'
import { isSessionTreeRestoreEvent } from './session-tree-marker.ts'
import type {
  JumpView,
  SessionTreeForkView,
  SessionTreeSessionInfo,
  SessionTreeView,
  TreeNode,
} from './types.ts'

export { SessionTree, SessionTreeStore, sessionTreeStore } from './session-tree.ts'
export type * from './types.ts'
export { attachToolResult, isInjectedUserNode, isInjectedUserSource, sessionEventsToTreeNodes, toolResultOf, type ProjectedToolResult } from './session-event-adapter.ts'
export { defaultSidecarRoot, flushSessionTreeSidecar, getSessionTreeSidecar, persistSessionTree, setSessionTreeSidecar, SessionTreeSidecar } from './session-tree-sidecar.ts'
export { isSessionTreeRestoreEvent, sessionTreeMarkerOf, type SessionTreeRestoreMarker } from './session-tree-marker.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionTree: SessionTreeService
  }
}

/** Selected-message-surface API added by the repository's optional dev/session-branch-surface.patch. */
interface SelectedMessageSurfaceSession {
  selectMessageSurface(nodes: readonly number[] | null): void
  messageSurfaceNodes(): readonly number[]
}

/**
 * Whether a live Session exposes the selected-message-surface API shipped by
 * this repository's `dev/session-branch-surface.patch`. A stock DeepSeek-Harness
 * install (the target of `dsh plugin add`) has no such API: `deriveMessages()`
 * always walks the canonical surface, and unknown `session-tree/*` events
 * cannot be marked `ignorable` through the public append API, so a profile
 * cannot persist them. The tree remains fully browsable and branchable inside
 * the process store in that mode; only the in-place model-surface switch is
 * unavailable.
 */
export function supportsSelectedMessageSurface(
  session: Session,
): session is Session & SelectedMessageSurfaceSession {
  const candidate = session as Partial<SelectedMessageSurfaceSession>
  return typeof candidate.selectMessageSurface === 'function'
    && typeof candidate.messageSurfaceNodes === 'function'
}

/** How cursor movements reach the model-visible Session surface on this build. */
export type SessionTreeSurfaceMode = 'native' | 'projection'

/** Sessions already announced in the Host log, so each notice fires once. */
const surfaceNoticesSent = new WeakMap<object, Set<SessionTreeSurfaceMode>>()

/**
 * The active surface mode for one session:
 * - `native` — `dev/session-branch-surface.patch` (or an upstream merge)
 *   provides `Session.selectMessageSurface()`; jump/fork switch the model
 *   history directly.
 * - `stock` — retired by the 0.2.2 adaptation: emulating the switch through a
 *   synthetic `replace` surface event plus the durable sidecar mutates the live
 *   surface and can make the persisted log unreplayable when the default
 *   compaction pipeline runs. Never returned by this build.
 * - `projection` — the live surface is not writable in this revision;
 *   navigation updates the tree projection and panel only, and the Session log
 *   is left byte-for-byte untouched.
 */
export function sessionTreeSurfaceMode(session: Session): SessionTreeSurfaceMode {
  if (supportsSelectedMessageSurface(session)) return 'native'
  // DSH 0.2.2 adaptation: stock surface rewriting is disabled on purpose.
  return 'projection'
}

/** Announce a non-native mode once per session in the Host log. */
function noticeSurfaceMode(
  session: Session,
  mode: Exclude<SessionTreeSurfaceMode, 'native'>,
  detail: string,
): void {
  let sent = surfaceNoticesSent.get(session)
  if (sent === undefined) {
    sent = new Set()
    surfaceNoticesSent.set(session, sent)
  }
  if (sent.has(mode)) return
  sent.add(mode)
  console.warn(`[session-tree] ${String(session.id)}: ${detail}`)
}

/**
 * Whether the running Harness recognizes the durable `session-tree/*` event
 * vocabulary. That vocabulary ships with the optional
 * `dev/session-branch-surface.patch`; without it an appended unknown event
 * would make a resumed persisted log unreadable, so callers must skip those
 * appends. No such append happens in projection mode.
 */
export function supportsDurableSessionTreeEvents(session: Session): boolean {
  return supportsSelectedMessageSurface(session)
}

/** Durable SessionTree event types appended to the owning Session log. */
export type SessionTreeEventType =
  | 'session-tree/node'
  | 'session-tree/cursor'
  | 'session-tree/branch'
  | 'session-tree/selection'
  | 'session-tree/snapshot'

/**
 * Append one durable SessionTree marker when the runtime supports it, and
 * return undefined on stock Harness so callers can skip sequence tracking.
 */
export function appendSessionTreeEvent(
  session: Session,
  type: SessionTreeEventType,
  data: SessionEventMap[SessionTreeEventType],
): SessionEvent<SessionTreeEventType> | undefined {
  if (!supportsDurableSessionTreeEvents(session)) return undefined
  return session.append(type, data)
}

/** Event types needed to keep a copied path replayable without conversation noise. */
const STRUCTURAL_EVENT_TYPES = new Set<SessionEvent['type']>([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'request/header',
])

/** Source seqs represented by one tree node, including merged tool results. */
function sourceSeqsOf(node: TreeNode): number[] {
  const seqs: number[] = []
  const primary = node.metadata?.sessionEventSeq
  if (typeof primary === 'number') seqs.push(primary)
  const result = node.metadata?.toolResultEventSeq
  if (typeof result === 'number') seqs.push(result)
  return seqs
}

/**
 * The Session event log across Harness builds. The agent-facing Session
 * wrapper exposes an `events` array, while the persisted core Session shipped
 * in published Harness builds only offers `snapshotEvents()`; code paths that
 * must run in both hosts read the log through this accessor. An unreadable
 * log yields an empty array so tree sync degrades instead of throwing inside
 * the gateway.
 */
function sessionEvents(session: Session): readonly SessionEvent[] {
  const candidate = session as Session & {
    events?: readonly SessionEvent[]
    snapshotEvents?: () => readonly SessionEvent[]
  }
  if (Array.isArray(candidate.events)) return candidate.events
  if (typeof candidate.snapshotEvents === 'function') {
    const snapshot = candidate.snapshotEvents()
    if (Array.isArray(snapshot)) return snapshot
  }
  return []
}

/**
 * Build a fresh-session seed from only the selected root-to-node path.
 *
 * The source Session is read through its immutable event snapshot; no append,
 * cursor, or surface method is called. Structural events keep copied turns
 * replayable, while events from sibling branches and messages after the
 * selected user prompt are deliberately omitted. Sequence numbers are rebuilt
 * contiguously because Agent creation requires a valid independent log.
 */
export function sessionPathForkSeed(
  source: Session,
  path: readonly TreeNode[],
): readonly SessionEvent[] {
  const wanted = new Set<number>()
  let anchorSeq = -1
  for (const node of path) {
    const seqs = sourceSeqsOf(node)
    for (const seq of seqs) wanted.add(seq)
    anchorSeq = Math.max(anchorSeq, ...seqs)
  }
  if (anchorSeq < 0) return []

  // Keep the enclosing turn boundary (if any) so a user-only path remains a
  // balanced, durable Session seed; filtering removes its assistant content.
  const events = sessionEvents(source)
  const boundary = events.find(event => event.seq >= anchorSeq && event.type === 'turn/end')?.seq ?? anchorSeq
  const kept: SessionEvent[] = []
  for (const event of events) {
    if (event.seq > boundary) break
    const isWanted = wanted.has(event.seq)
      || (event.type === 'session-tree/node' && sourceSeqsOf(event.data.node).some(seq => wanted.has(seq)))
    if (isWanted || STRUCTURAL_EVENT_TYPES.has(event.type)) kept.push(event)
  }

  const seedIndexBySourceSeq = new Map<number, number>()
  return kept.map((event, index) => {
    seedIndexBySourceSeq.set(event.seq, index)
    const record = JSON.parse(JSON.stringify(event)) as SessionEvent
    record.seq = SessionSeq(index)
    // A copied subset cannot keep replace ranges that point at omitted source
    // seqs. All retained path events become appends in the target's own space.
    if (isSurfaceEvent(record)) {
      record.surfaceOp = 'append'
      delete record.sourceEventSeqs
    }
    if (record.type === 'session-tree/node') {
      const metadata = record.data.node.metadata
      const primary = typeof metadata?.sessionEventSeq === 'number' ? metadata.sessionEventSeq : undefined
      const mappedPrimary = primary === undefined ? undefined : seedIndexBySourceSeq.get(primary)
      const resultSeq = typeof metadata?.toolResultEventSeq === 'number' ? metadata.toolResultEventSeq : undefined
      const mappedResult = resultSeq === undefined ? undefined : seedIndexBySourceSeq.get(resultSeq)
      record.data = {
        ...record.data,
        node: {
          ...record.data.node,
          metadata: {
            ...metadata,
            ...(mappedPrimary === undefined ? {} : { sessionEventSeq: mappedPrimary, sourceEventSeq: mappedPrimary }),
            ...(mappedResult === undefined ? {} : { toolResultEventSeq: mappedResult }),
          },
        },
      }
    }
    return record
  })
}

/**
 * Build a fork seed from the full Session prefix up to the selected path's
 * boundary. Unlike {@link sessionPathForkSeed} this keeps assistant and tool
 * events, so the child's inherited turns render with their real content.
 * Sequence numbers are rebuilt contiguously; surface replacements become
 * appends because their source ranges do not exist in the child.
 */
export function sessionPrefixForkSeed(
  source: Session,
  path: readonly TreeNode[],
  targetId: SessionId,
): readonly SessionEvent[] {
  let anchorSeq = -1
  for (const node of path) {
    for (const seq of sourceSeqsOf(node)) anchorSeq = Math.max(anchorSeq, seq)
  }
  if (anchorSeq < 0) return []
  const events = sessionEvents(source)
  const boundary = events.find(event => event.seq >= anchorSeq && event.type === 'turn/end')?.seq ?? anchorSeq
  // Keep the full contiguous prefix and reuse the native closet. Surface
  // replacements (`surfaceOp: {op:'replace'}` + `sourceEventSeqs`) MUST be
  // preserved: their source rows are inside the prefix, and rewriting them to
  // appends re-exposes compacted tool results with stale turn/step metadata,
  // which the seeded-log validator rejects.
  const prefix = events.slice(0, boundary + 1)
  const closed = buildForkSeed(prefix, SessionSeq(boundary))
  return closed.map((event: SessionEvent, index: number) => {
    const record = JSON.parse(JSON.stringify(event)) as SessionEvent
    record.seq = SessionSeq(index)
    if (record.type === 'session-tree/snapshot') {
      record.data = { ...record.data, snapshot: { ...record.data.snapshot, sessionId: targetId } }
    }
    // Delivery markers validate their Session identity on load; inherited job
    // events name their owner. Both must move to the child or the log is
    // rejected as corrupt ("delivery marker names the wrong Session").
    const identified = record as unknown as { type: string; data: Record<string, unknown> }
    if (identified.type === 'session-log-deepseek/delivery-accepted') {
      identified.data = { ...identified.data, sessionId: targetId }
    }
    if ((identified.type === 'job/registered' || identified.type === 'job/settled')
      && identified.data.owner === source.id) {
      identified.data = { ...identified.data, owner: targetId }
    }
    return record
  })
}

/**
 * Index of the inherited `session/end-seed` marker inside a fork seed.
 *
 * Harness `Session` validates `inheritedEventCount` by reading
 * `this.log[inheritedEventCount]` and requiring the inherited marker there, so
 * this is the marker's index, not the next event. Native forks pass
 * `boundary + 1`, which is exactly the marker's seq after `buildForkSeed`
 * appends it.
 */
export function inheritedEventCountOf(seed: readonly SessionEvent[]): number {
  return seed.reduce(
    (count, event) => event.type === 'session/end-seed'
      && (event.data as { inherited?: unknown }).inherited === true
      ? event.seq
      : count,
    0,
  )
}

/** Project the exact native log, shared by fork creation and cold reconstruction. */
function projectNativeTree(sessionId: SessionId, events: readonly SessionEvent[]): SessionTree {
  const nativeEvents = events.filter(event => event.type === 'turn/start'
    || event.type === 'tool/call' || event.type === 'request/context' || isSurfaceEvent(event))
  const nodes = sessionEventsToTreeNodes(nativeEvents)
  const tree = new SessionTree(sessionId)
  const replay = tree.replay(nodes.map((node, seq) => ({ seq, node })))
  if (!replay.ok) throw new Error(`${replay.error.code}: ${replay.error.message}`)
  const latest = events.at(-1)?.seq
  if (latest !== undefined) tree.markSessionEventSeq(latest)
  return tree
}

/** Keep every inherited node before advancing the fork's log watermark. */
function createForkTargetTree(
  targetId: SessionId,
  seed: readonly SessionEvent[],
  selectedNodeId: string,
  branchName: string,
): SessionTree {
  const tree = projectNativeTree(targetId, seed)
  const nativeTail = tree.cursor
  const selected = tree.select(selectedNodeId)
  if (!selected.ok) throw new Error(`${selected.error.code}: ${selected.error.message}`)
  // Selection names the validated fork prompt; continuation follows the log
  // tail, which may be an assistant/tool node and is not itself a fork point.
  const snapshot = tree.snapshot()
  return new SessionTree(targetId, {
    ...snapshot,
    activeBranch: branchName,
    branchHeads: { ...snapshot.branchHeads, [branchName]: nativeTail ?? selectedNodeId },
  })
}

/** Extract the complete editable text of a projected user prompt. */
function promptTextOf(node: TreeNode): string {
  const parts = (node.content ?? [])
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
  const text = parts.join('\n').trim()
  return text === '' ? node.message?.content ?? node.summary : text
}

/** Optional side-effect controls for callers that only need to inspect history. */
export interface SyncSessionTreeOptions {
  /** Apply the tree cursor to the model-visible Session surface (default true). */
  readonly applySurface?: boolean
  /** Persist the projected tree sidecar (default true). */
  readonly persist?: boolean
}

/** Materialize and incrementally synchronize native Harness history. */
export function syncSessionTree(agent: Agent, options: SyncSessionTreeOptions = {}): SessionTree {
  const sessionId = agent.session.id
  const events = sessionEvents(agent.session)
  const actualLatestSeq = events.at(-1)?.seq ?? -1
  let existing = sessionTreeStore.get(sessionId)
  // Fast path: a navigation click or panel read with no new Session events must
  // not deep-clone and replay the whole tree (that made clicks feel like a load).
  if (existing !== undefined && existing.lastSessionEventSeq() === actualLatestSeq) {
    if (options.applySurface !== false) applyTreeCursorToSession(agent, existing)
    if (options.persist !== false) persistSessionTree(existing)
    return existing
  }
  // A persisted projection can sit ahead of the durable log when the sidecar
  // was written before the Session log flushed, or when a log/sidecar pair was
  // copied from another machine. Rewinding only the watermark would keep the
  // extra `session-event-*` nodes, so the next fresh event would collide with
  // one of them and every sync would fail with INVALID_SNAPSHOT. Drop and
  // rebuild instead: the native log is the source of truth here.
  if (existing !== undefined && existing.lastSessionEventSeq() > actualLatestSeq) {
    sessionTreeStore.delete(sessionId)
    existing = undefined
  }
  let restored = existing === undefined ? getSessionTreeSidecar().load(sessionId) : undefined
  if (restored !== undefined && restored.lastSessionEventSeq() > actualLatestSeq) {
    getSessionTreeSidecar().discard(sessionId)
    restored = undefined
  }
  // Legacy fork caches advanced to the complete seed watermark after replaying
  // only the selected prompt path. Validate such a restored cache once against
  // its inherited log, retaining the selection when rebuilding missing nodes.
  if (restored !== undefined && agent.session.header?.parentSession !== undefined
    && !events.some(event => event.type.startsWith('session-tree/'))) {
    const projected = projectNativeTree(sessionId, events)
    const cached = restored
    if (projected.list().some(node => typeof node.metadata?.sessionEventSeq === 'number'
      && node.metadata.sessionEventSeq <= cached.lastSessionEventSeq() && !cached.has(node.nodeId))) {
      const previous = restored.snapshot()
      const snapshot = projected.snapshot()
      restored = new SessionTree(sessionId, {
        ...snapshot,
        selectedNodeId: previous.selectedNodeId != null && projected.has(previous.selectedNodeId)
          ? previous.selectedNodeId : snapshot.selectedNodeId,
        branchHeads: { ...snapshot.branchHeads, ...Object.fromEntries(
          Object.entries(previous.branchHeads ?? {}).filter(([, id]) => projected.has(id)),
        ) },
      })
    }
  }
  // Cold native projections contain no explicit tree operations. Replay the
  // complete projection atomically instead of cloning/validating the growing
  // tree once per event (quadratic work on long histories after cache renewal).
  if (existing === undefined && restored === undefined
    && !events.some(event => event.type.startsWith('session-tree/'))) {
    const rebuilt = projectNativeTree(sessionId, events)
    sessionTreeStore.replace(sessionId, rebuilt)
    if (options.applySurface !== false) applyTreeCursorToSession(agent, rebuilt)
    if (options.persist !== false) persistSessionTree(rebuilt)
    return rebuilt
  }
  let tree = existing === undefined
    ? restored ?? new SessionTree(sessionId)
    : new SessionTree(sessionId, existing.snapshot())
  tree.limitSessionEventSeq(actualLatestSeq)
  const lastSeq = tree.lastSessionEventSeq()
  const freshEvents = sessionEvents(agent.session).filter(event => event.seq > lastSeq)
  let nativeParentId = tree.cursor
  for (const event of freshEvents) {
    if (event.type === 'session-tree/snapshot') {
      if (event.data.snapshot.sessionId !== sessionId) throw new Error('INVALID_SNAPSHOT: snapshot session does not match the owning Session')
      try {
        tree = new SessionTree(sessionId, event.data.snapshot)
      } catch (error) {
        throw new Error(`INVALID_SNAPSHOT: ${error instanceof Error ? error.message : 'invalid snapshot'}`)
      }
      tree.markSessionEventSeq(event.seq)
      nativeParentId = tree.cursor
      continue
    }
    if (event.type === 'session-tree/cursor') {
      const moved = tree.jump(event.data.nodeId)
      if (!moved.ok) throw new Error(`${moved.error.code}: ${moved.error.message}`)
      nativeParentId = event.data.nodeId
      continue
    }
    if (event.type === 'session-tree/branch') {
      const branched = tree.branch(event.data.nodeId, event.data.branch)
      if (!branched.ok) throw new Error(`${branched.error.code}: ${branched.error.message}`)
      nativeParentId = event.data.nodeId
      continue
    }
    if (event.type === 'session-tree/selection') {
      const selected = tree.select(event.data.nodeId)
      if (!selected.ok) throw new Error(`${selected.error.code}: ${selected.error.message}`)
      continue
    }
    // Explicit session-tree nodes are durable tree records, not model-surface
    // events; they must be projected even though they are absent from surface.
    const isExplicitTreeNode = event.type === 'session-tree/node'
    const isTreeMetadataEvent = event.type === 'tool/call' || event.type === 'request/context'
    // Keep every append-origin and replacement surface event, including nodes
    // shadowed by compaction. Pi's tree is the immutable history graph, not the
    // current flattened model surface.
    if (!isExplicitTreeNode && !isTreeMetadataEvent && !isSurfaceEvent(event)) continue
    // A tool call and its result are one interaction: fold the result into the
    // already-projected tool-call node instead of appending a second entry.
    // This covers results that arrive in a later sync batch than their call.
    if (event.type === 'tool/result') {
      const result = toolResultOf(event)
      const callNode = result === undefined ? undefined : tree.findToolCallNode(result.callId)
      if (callNode !== undefined && result !== undefined) {
        const merged = attachToolResult(callNode, result, event.seq)
        const attached = tree.attachToolResult(result.callId, merged)
        if (!attached.ok) throw new Error(`${attached.error.code}: ${attached.error.message}`)
        continue
      }
    }
    const nodes = sessionEventsToTreeNodes([event], nativeParentId)
    if (nodes.length === 0) continue
    const first = nodes[0]
    if (first === undefined) continue
    const projected = isExplicitTreeNode ? first : { ...first, branch: tree.activeBranch }
    const restored = tree.replay([{ seq: tree.list().length, node: projected }])
    if (!restored.ok) throw new Error(`${restored.error.code}: ${restored.error.message}`)
    nativeParentId = projected.nodeId
  }
  const newestSeq = freshEvents[freshEvents.length - 1]?.seq
  if (newestSeq !== undefined) tree.markSessionEventSeq(newestSeq)
  sessionTreeStore.replace(sessionId, tree)
  if (options.applySurface !== false) applyTreeCursorToSession(agent, tree)
  if (options.persist !== false) persistSessionTree(tree)
  return tree
}

/**
 * Run one projection sync without letting a corrupt tree fail the caller.
 *
 * `agent/pre-step` runs before every model step; an exception there would
 * abort otherwise valid turns. On INVALID_SNAPSHOT the committed projection is
 * discarded (with the sidecar renamed aside) and rebuilt once from the native
 * log, which is the only unbounded-failure path the projection knows about.
 */
export function syncSessionTreeSafely(agent: Agent): SessionTree | undefined {
  try {
    return syncSessionTree(agent)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[session-tree] ${String(agent.session.id)}: projection sync failed: ${message}`)
    if (!message.includes('INVALID_SNAPSHOT')) return sessionTreeStore.get(agent.session.id)
    sessionTreeStore.delete(agent.session.id)
    getSessionTreeSidecar().discard(agent.session.id)
    try {
      return syncSessionTree(agent)
    } catch (retryError) {
      const retryMessage = retryError instanceof Error ? retryError.message : String(retryError)
      console.warn(`[session-tree] ${String(agent.session.id)}: projection rebuild failed: ${retryMessage}`)
      return sessionTreeStore.get(agent.session.id)
    }
  }
}

/** Surface event seqs making up the tree's current root-to-cursor path. */
function selectedSurfaceSeqs(tree: SessionTree, session: Session): number[] {
  const seqs: number[] = []
  // The tree projection intentionally omits system messages, but the active
  // system prompt remains the protected head of the model surface.
  for (const rawSeq of session.surface.nodes) {
    const seq = rawSeq as number
    const event = sessionEvents(session)[seq]
    if (event?.type === 'system/message' && !isSessionTreeRestoreEvent(event)) seqs.push(seq)
  }
  for (const node of tree.currentPath()) {
    // A merged tool node carries two native seqs: the call (metadata-only, not
    // a surface event) and the result (a real surface event that must stay on
    // the model-visible path together with its call).
    const nativeSeqs: number[] = []
    const primary = node.metadata?.sessionEventSeq
    if (typeof primary === 'number') nativeSeqs.push(primary)
    const resultSeq = node.metadata?.toolResultEventSeq
    if (typeof resultSeq === 'number') nativeSeqs.push(resultSeq)
    for (const seq of nativeSeqs) {
      const event = sessionEvents(session)[seq]
      if (event !== undefined && isSurfaceEvent(event)) seqs.push(seq)
    }
  }
  return seqs
}

/** Apply the selected tree path to Harness' actual model-visible Session surface. */
export function applyTreeCursorToSession(agent: Agent, tree: SessionTree): void {
  const session = agent.session
  if (supportsSelectedMessageSurface(session)) {
    session.selectMessageSurface(selectedSurfaceSeqs(tree, session))
    return
  }
  // DSH 0.2.2 adaptation: without the native selected-surface API the plugin
  // never rewrites the live surface and never appends replacement events.
  // Projection-only navigation cannot corrupt a resumable Session log; branch
  // names, cursors and selections live in the sidecar instead.
  noticeSurfaceMode(
    session,
    'projection',
    'projection mode: branch switching is disabled on this Harness build; '
      + 'the tree, /fork and /clone still work and the Session log is left untouched',
  )
  persistSessionTree(tree)
}

/** Remote-only service backing the browser tree panel. */
export class SessionTreeService extends TypertRemoteService {
  /**
   * Remote methods receive an `agentId` and resolve it through `ctx.agents`.
   * Declare the dependency so the lookup runs in this plugin's own fiber.
   */
  static inject = ['agents']

  /**
   * Register the service under `sessionTree`.
   * @param ctx - owning Cordis Context.
   */
  constructor(ctx: Context) {
    super(ctx, 'sessionTree')
    // Rehydrate the durable cursor before every proposed step, including a
    // resumed Session whose browser has not opened the tree panel yet.
    ctx.on('agent/pre-step', ({ agent }, next) => {
      syncSessionTreeSafely(agent)
      return next()
    })
    ctx.on('session/flush', (session) => {
      const tree = sessionTreeStore.get(session.id)
      if (tree !== undefined) persistSessionTree(tree)
      flushSessionTreeSidecar()
    })
  }

  /**
   * Read the current tree view (nodes, branches, cursor) for one agent.
   * The tree is created on first read, so an empty panel is valid.
   * @param agent - owning live agent.
   * @returns the complete view for the panel.
   */
  @Remote('list')
  list(agent: Agent): SessionTreeView {
    return this.synced(agent).view()
  }

  /** Synchronize native history, falling back to the last committed tree when replay fails. */
  private synced(agent: Agent): SessionTree {
    try {
      return syncSessionTree(agent)
    } catch {
      const committed = sessionTreeStore.require(agent.session.id)
      if (!committed.ok) throw new Error(`${committed.error.code}: ${committed.error.message}`)
      return committed.value
    }
  }

  /** Read the projected tree without mutating the source Session surface. */
  private readOnlyTree(agent: Agent): SessionTree {
    return syncSessionTree(agent, { applySurface: false, persist: false })
  }

  /**
   * Move the SessionTree cursor to an existing node and return its root-to-node
   * path through the context operation. On a Harness build with the native
   * selected-surface API this also re-points the model-visible Session surface;
   * otherwise navigation stays projection-only and the canonical history is
   * left untouched.
   * @param agent - owning live agent.
   * @param nodeId - target node, or null to reset before the first node.
   * @returns the new cursor and reconstructed messages.
   * @throws Error when the node does not exist (settles as the standard error envelope).
   */
  @Remote('jump')
  jump(agent: Agent, nodeId: string | null): JumpView {
    const tree = syncSessionTree(agent)
    const checkpoint = tree.checkpoint()
    const result = tree.jump(nodeId)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    try {
      const event = appendSessionTreeEvent(agent.session, 'session-tree/cursor', { nodeId })
      if (event !== undefined) tree.markSessionEventSeq(event.seq)
      if (nodeId !== null) {
        const selected = tree.select(nodeId)
        if (!selected.ok) throw new Error(`${selected.error.code}: ${selected.error.message}`)
        const selection = appendSessionTreeEvent(agent.session, 'session-tree/selection', { nodeId })
        if (selection !== undefined) tree.markSessionEventSeq(selection.seq)
      }
      applyTreeCursorToSession(agent, tree)
    } catch (error) {
      tree.rollback(checkpoint)
      throw error
    }
    return result.value
  }

  /**
   * Position a named branch at a historical node for the next append.
   * @param agent - owning live agent.
   * @param nodeId - historical node to branch from.
   * @param branch - non-empty branch label.
   * @returns the parked cursor, branch label, and direct-child fork count.
   */
  @Remote('fork')
  fork(agent: Agent, nodeId: string, branch: string): { cursor: string; branch: string; forkCount: number } {
    const branchName = branch === '' ? 'fork' : branch
    const tree = syncSessionTree(agent)
    const checkpoint = tree.checkpoint()
    const result = tree.fork(nodeId, branchName)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    try {
      const selected = tree.select(nodeId)
      if (!selected.ok) throw new Error(`${selected.error.code}: ${selected.error.message}`)
      const event = appendSessionTreeEvent(agent.session, 'session-tree/branch', { nodeId, branch: result.value.branch })
      if (event !== undefined) tree.markSessionEventSeq(event.seq)
      const selection = appendSessionTreeEvent(agent.session, 'session-tree/selection', { nodeId })
      if (selection !== undefined) tree.markSessionEventSeq(selection.seq)
      applyTreeCursorToSession(agent, tree)
    } catch (error) {
      tree.rollback(checkpoint)
      throw error
    }
    return result.value
  }

  /**
   * Copy only the selected user-node root path into a brand-new Session.
   * @param agent - owning live source agent.
   * @param nodeId - selected user-message node.
   * @param branch - branch label installed on the independent copy.
   * @returns the source fork point plus target session and editable prompt.
   */
  @Remote('forkSession')
  async forkSession(agent: Agent, nodeId: string, branch: string): Promise<SessionTreeForkView> {
    const branchName = branch === '' ? 'fork' : branch
    // Independent forks must not invoke jump/branch/surface methods on the
    // source: the source JSONL remains byte-for-byte unchanged.
    const tree = this.readOnlyTree(agent)
    const selectedNode = tree.list().find(node => node.nodeId === nodeId)
    if (selectedNode === undefined) throw new Error('NODE_NOT_FOUND: node was not found')
    if (selectedNode?.message?.role !== 'user') {
      throw new Error('INVALID_ARGUMENT: forkSession requires a user-message node')
    }
    const latestUser = tree.list().filter(node => node.message?.role === 'user' && !isInjectedUserNode(node)).at(-1)
    if (latestUser?.nodeId !== nodeId) {
      throw new Error('STALE_FORK_POINT: only the latest user turn can be forked')
    }
    const path = tree.currentPath(nodeId)
    if (path[path.length - 1]?.nodeId !== nodeId) {
      throw new Error('NODE_NOT_FOUND: fork path could not be reconstructed')
    }
    const source = agent.session
    const targetId = toSessionId(`${source.id}-fork-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
    // Keep the complete prefix up to the fork boundary: a user-only seed made
    // the child's inherited turns render as empty "completed" separators.
    const seed = sessionPrefixForkSeed(source, path, targetId)
    // A seeded Session must declare how many leading events it inherited; the
    // loader rejects a seeded header without this count.
    const inheritedEventCount = inheritedEventCountOf(seed)
    const targetTree = createForkTargetTree(targetId, seed, nodeId, branchName)
    // Compose the child with the source preset. Without the preset's tool
    // mount the child registers fewer tools than its inherited history uses,
    // and the provider rejects the resumed request ("tool result has no
    // matching call"). The preset service is the only context that can mount
    // the tools, so mirror the Host's composeAgent here.
    const presets = this.ctx.get('agentPresets') as unknown as {
      resolve(id?: string): Promise<{ id: string }>
      mount(agentCtx: unknown, id: string): Promise<void>
      presetForSession?(session: Session): string | undefined
    } | undefined
    let composition: { setup?: (agentCtx: unknown) => Promise<void>; agentPreset?: string } | undefined
    if (presets !== undefined) {
      try {
        const requested = presets.presetForSession?.(source) ?? source.header.agentPreset
        const resolved = await presets.resolve(requested)
        composition = {
          agentPreset: resolved.id,
          setup: async agentCtx => { await presets.mount(agentCtx, resolved.id) },
        }
      } catch {
        composition = undefined
      }
    }
    try {
      await this.ctx.agents.create({
        sessionId: targetId,
        ...(seed.length === 0 ? {} : { seed, inheritedEventCount: SessionLogOffset(inheritedEventCount) }),
        meta: {
          parentSession: source.id,
          isSeeded: seed.length > 0,
          // Harness history/list only serves ordinary Sessions with a cwd.
          // Inherit the source project so the fork is a usable real Session
          // instead of a store-only id that fails session/not-found.
          cwd: source.header.cwd ?? process.cwd(),
          ...(composition?.agentPreset ?? source.header.agentPreset) === undefined
            ? {}
            : { agentPreset: composition?.agentPreset ?? source.header.agentPreset },
        },
        agentOptions: agent.options,
        ...(composition?.setup === undefined ? {} : { setup: composition.setup }),
      } as never)
    } catch (error) {
      // Standalone hosts may not mount the loop-owned Agent factory. Real
      // Harness creates the live Session above; any other failure is real.
      if (!(error instanceof Error) || !error.message.includes('no agent factory registered')) throw error
    }
    // Mirror native forks: attach the child to the source's Workspace so it is
    // grouped in the sidebar instead of floating in the ungrouped section.
    const registry = this.ctx.get('workspaceRegistry') as unknown as {
      list(): ReadonlyArray<{ sessionIds: readonly SessionId[]; attachSession(id: SessionId): Promise<void> }>
    } | undefined
    const workspace = registry?.list().find(candidate => candidate.sessionIds.includes(source.id))
    if (workspace !== undefined) {
      try { await workspace.attachSession(targetId) } catch { /* the fork itself stays usable */ }
    }
    // Publish the projected tree only after the independent Session has been
    // accepted. A failed factory call therefore leaves no fork sidecar/store
    // entry behind, while the no-factory test/runtime fallback still exposes
    // the fully materialized target tree.
    sessionTreeStore.replace(targetId, targetTree)
    persistSessionTree(targetTree)
    // Unlike legacy fork(), the source tree is not branched or selected.
    const forkCount = tree.list().filter(node => node.parentId === nodeId).length
    // The fork-menu title names the previous TYPED prompt; harness injections
    // (skill catalog, system-prompt snapshot) on the path never qualify.
    const previousUser = path
      .slice(0, -1)
      .reverse()
      .find(node => node.message?.role === 'user' && !isInjectedUserNode(node))
    return {
      cursor: nodeId,
      branch: branchName,
      forkCount,
      sessionId: targetId,
      prompt: promptTextOf(selectedNode),
      ...(previousUser === undefined ? {} : { previousUserPrompt: promptTextOf(previousUser) }),
    }
  }

  /**
   * Legacy in-tree branch primitive retained for API compatibility. Prefer
   * {@link fork} in user-facing flows: it creates an isolated Session copy.
   */
  branchInPlace(agent: Agent, nodeId: string, branch: string): { cursor: string; branch: string; forkCount: number } {
    const branchName = branch === '' ? 'fork' : branch
    const tree = syncSessionTree(agent)
    const checkpoint = tree.checkpoint()
    const result = tree.fork(nodeId, branchName)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    try {
      const selected = tree.select(nodeId)
      if (!selected.ok) throw new Error(`${selected.error.code}: ${selected.error.message}`)
      const event = appendSessionTreeEvent(agent.session, 'session-tree/branch', { nodeId, branch: result.value.branch })
      if (event !== undefined) tree.markSessionEventSeq(event.seq)
      const selection = appendSessionTreeEvent(agent.session, 'session-tree/selection', { nodeId })
      if (selection !== undefined) tree.markSessionEventSeq(selection.seq)
      applyTreeCursorToSession(agent, tree)
    } catch (error) {
      tree.rollback(checkpoint)
      throw error
    }
    return result.value
  }

  /**
   * Read compact status metadata for the current session tree.
   * @param agent - owning live agent.
   * @returns current tree counts, cursor, branches, and usage metadata.
   */
  @Remote('session')
  session(agent: Agent): SessionTreeSessionInfo {
    return this.synced(agent).info()
  }
}

export default SessionTreeService
