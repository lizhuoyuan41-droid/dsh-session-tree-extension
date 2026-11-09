function focusRowFirst(rows: readonly SessionGraphRow[], focusKey: string): readonly SessionGraphRow[] {
  const index = rows.findIndex(row => row.key === focusKey)
  if (index <= 0) return rows
  return [rows[index]!, ...rows.slice(0, index), ...rows.slice(index + 1)]
}

/**
 * Read-only projection of a Session lineage into one merged node graph.
 *
 * Session-level topology comes from the native Session list. Node-level
 * topology comes from each Session's own tree view. Native forks copy the
 * source log prefix with event sequence numbers intact, so the deepest shared
 * root-path prefix is the fork anchor. Only that prefix is deduplicated; every
 * branch-specific node keeps a session-qualified identity.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionTreeView, TreeNode } from '@robiteame/dsh-pi-agent-session-tree/client'
import type { ForkLineageEntry } from './fork-lineage.ts'
import { isInjectedUserNode } from './node-text.ts'

/** Which kind of Session a row represents. */
export type BranchTreeBadge = 'main' | 'fork' | 'clone'

/** One Session in the derived lineage. */
export interface BranchTreeRow {
  readonly sessionId: SessionId
  readonly parentId: SessionId | undefined
  readonly title: string
  /** 0 is the trunk root; each nesting level adds one. */
  readonly depth: number
  /** Last sibling stops the parent rail below its elbow. */
  readonly isLast: boolean
  /** Per ancestor level above the parent: whether its rail continues below. */
  readonly railContinues: readonly boolean[]
  readonly childCount: number
  readonly running: boolean
  /** The Session the UI currently has open. */
  readonly current: boolean
  /** On the root-to-current chain. */
  readonly onActivePath: boolean
  /** Session creation time in ms (lineage first, list update as fallback). */
  readonly createdAt?: number
  /** Permanent branch ordinal (creation order, archived included, never reused). */
  readonly branchNumber?: number
  readonly badge: BranchTreeBadge
  readonly branchLabel: string | undefined
}

/** Derived Session-level lineage in DFS pre-order. */
export interface BranchTreeModel {
  readonly rows: readonly BranchTreeRow[]
  readonly rootId: SessionId
  readonly highlightedId: SessionId
  readonly activeAncestors: ReadonlySet<SessionId>
}

/** Read-only projection input shared by the graph builder and tests. */
export interface BranchTreeListState {
  readonly ids?: readonly SessionId[]
  readonly byId?: Readonly<Record<SessionId, unknown>> | undefined
  readonly current?: SessionId | undefined
}

interface SessionRowView {
  readonly parentId: SessionId | undefined
  readonly displayTitle: string | undefined
  readonly running: boolean
  readonly updatedAt: number
  readonly subagent: boolean
}

/** One badge rendered where a Session branch starts. */
export interface SessionGraphBadge {
  readonly sessionId: SessionId
  readonly kind: BranchTreeBadge
  readonly branchLabel: string | undefined
  readonly title: string
  readonly running: boolean
  readonly current: boolean
  /** Stable identity for independently collapsing this Session branch. */
  readonly collapseKey: string
  /** Whether collapsing this badge can hide at least one branch-owned row. */
  readonly hasChildren: boolean
}

/** Why a Session has a synthetic placeholder row instead of its nodes. */
export type SessionGraphPlaceholder = 'loading' | 'error' | 'empty' | 'fork'

/** One render-ready node row in the merged graph. */
export interface SessionGraphRow {
  /** Session-qualified key for unique nodes; the shared key for a copied prefix. */
  readonly key: string
  readonly parentKey: string | null
  readonly node: TreeNode
  readonly owners: readonly SessionId[]
  readonly badges: readonly SessionGraphBadge[]
  readonly lane: number
  readonly parentLane: number | null
  readonly continues: readonly number[]
  readonly hasChildren: boolean
  /** Branch-owned rows hidden by this row's branch collapse keys. */
  readonly branchKeys: readonly string[]
  /** Lanes this node spawns as new branches (edges belong to the parent row). */
  readonly branchOutLanes: readonly number[]
  /** Stable color index per branch-out lane, aligned with branchOutLanes. */
  readonly branchOutColors: readonly number[]
  /** Pass-through rail colors aligned with `continues`. */
  readonly continueColors: readonly number[]
  /** Stable branch color index (creation order), independent of lane moves. */
  readonly colorIndex: number
  /** Previous lane when this row's branch shifted right at insertion time. */
  readonly laneShiftFrom: number | null
  /** Each owning Session's own node id for this shared row. */
  readonly ownerNodeIds: ReadonlyMap<SessionId, string>
  /** The current Session's selected node. */
  readonly active: boolean
  /** On the current Session's selected-node path. */
  readonly onActivePath: boolean
  readonly placeholder: SessionGraphPlaceholder | undefined
}

/** Complete merged graph plus the keys needed for reveal-on-open behavior. */
export interface SessionGraphModel {
  readonly rows: readonly SessionGraphRow[]
  readonly sessionIds: readonly SessionId[]
  readonly failedSessionIds: readonly SessionId[]
  readonly highlightedId: SessionId
  readonly activePathKeys: ReadonlySet<string>
  readonly activeBranchKeys: ReadonlySet<string>
}

/**
 * Keep only the subtree rooted at `focusKey`: the node itself plus every
 * descendant branch. The focused node becomes the new trunk (lane 0), all
 * ancestor and sibling rows disappear, and branch-out/continue lanes are
 * recomputed from the rows that remain.
 */
export function focusSessionGraph(model: SessionGraphModel, focusKey: string): SessionGraphModel {
  const focus = model.rows.find(row => row.key === focusKey)
  if (focus === undefined) return model
  const children = new Map<string, SessionGraphRow[]>()
  for (const row of model.rows) {
    if (row.parentKey === null) continue
    const siblings = children.get(row.parentKey)
    if (siblings === undefined) children.set(row.parentKey, [row])
    else siblings.push(row)
  }
  const keep = new Set<string>()
  const pending: string[] = [focusKey]
  while (pending.length > 0) {
    const key = pending.pop()!
    if (keep.has(key)) continue
    keep.add(key)
    for (const child of children.get(key) ?? []) pending.push(child.key)
  }

  const offset = focus.lane
  const shiftLane = (lane: number): number => Math.max(0, lane - offset)
  const kept = model.rows.filter(row => keep.has(row.key))
  const originalByKey = new Map(model.rows.map(row => [row.key, row]))
  // The focused node is the view's new root: pin it to the first row so the
  // panel can always scroll it to the top, regardless of insertion order.
  const anchored = focusRowFirst(kept, focusKey)
  const rows = anchored
    .map(row => ({
      ...row,
      lane: shiftLane(row.lane),
      parentKey: row.key === focusKey ? null : row.parentKey,
      parentLane: null as number | null,
      continues: row.continues.map(shiftLane),
      branchOutLanes: row.branchOutLanes.map(shiftLane),
      laneShiftFrom: null,
    }))
  const byKey = new Map(rows.map(row => [row.key, row]))
  const direct = new Map<string, SessionGraphRow[]>()
  for (const row of rows) {
    if (row.parentKey === null || !byKey.has(row.parentKey)) continue
    const siblings = direct.get(row.parentKey)
    if (siblings === undefined) direct.set(row.parentKey, [row])
    else siblings.push(row)
  }
  const focused = rows.map(row => {
    const children = direct.get(row.key) ?? []
    const continuing = children.filter(child => child.lane === row.lane)
    const branching = children.filter(child => child.lane !== row.lane)
    const original = originalByKey.get(row.key)
    // Lanes shifted by `offset`; reuse the original edge colour for the same
    // branch so filtering never repaints a surviving connection.
    const originalColor = (lane: number): number | undefined => {
      if (original === undefined) return undefined
      const laneBefore = lane + offset
      const branchIndex = original.branchOutLanes.indexOf(laneBefore)
      if (branchIndex !== -1) return original.branchOutColors[branchIndex]
      const continueIndex = original.continues.indexOf(laneBefore)
      return continueIndex === -1 ? undefined : original.continueColors[continueIndex]
    }
    return {
      ...row,
      parentLane: row.parentKey === null ? null : byKey.get(row.parentKey)?.lane ?? null,
      hasChildren: children.length > 0,
      continues: continuing.map(child => child.lane),
      branchOutLanes: branching.map(child => child.lane),
      branchOutColors: branching.map(child => originalColor(child.lane) ?? child.colorIndex),
      continueColors: continuing.map(child => originalColor(child.lane) ?? child.colorIndex),
    }
  })
  return {
    ...model,
    rows: focused,
    sessionIds: [...new Set(focused.flatMap(row => row.owners))],
    activePathKeys: new Set([...model.activePathKeys].filter(key => keep.has(key))),
    activeBranchKeys: new Set([...model.activeBranchKeys].filter(key => keep.has(key))),
  }
}


interface MutableGraphNode {
  readonly key: string
  readonly node: TreeNode
  parentKey: string | null
  readonly owners: Set<SessionId>
  readonly ownerNodeIds: Map<SessionId, string>
  readonly badges: SessionGraphBadge[]
  readonly branchKeys: Set<string>
  order: number
  readonly placeholder: SessionGraphPlaceholder | undefined
}

function rowViewOf(summary: unknown): SessionRowView {
  const row = (summary ?? {}) as {
    parentId?: unknown
    displayTitle?: unknown
    running?: unknown
    updatedAt?: unknown
    origin?: unknown
  }
  return {
    parentId: typeof row.parentId === 'string' ? row.parentId as SessionId : undefined,
    displayTitle: typeof row.displayTitle === 'string' && row.displayTitle !== '' ? row.displayTitle : undefined,
    running: row.running === true,
    updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
    subagent: row.origin === 'subagent',
  }
}

/**
 * Flatten one Session lineage into ordered worktree rows. The trunk is the
 * oldest ancestor of `sessionId` still present in the live list; children
 * nest under their parent ordered by creation, then list order. Cycles and
 * missing rows are skipped, never followed.
 */
export function buildBranchTreeModel(
  sessionId: SessionId,
  state: BranchTreeListState,
  entries: ReadonlyMap<SessionId, ForkLineageEntry>,
  archived: ReadonlySet<SessionId> = new Set(),
): BranchTreeModel | null {
  const byId = state.byId ?? {}
  if (!Object.prototype.hasOwnProperty.call(byId, sessionId)) return null

  // An archived fork is no longer an active branch: it must not leave a fork
  // marker or line on the source tree. The branch menu lists it separately so
  // it can still be found and restored.
  const viewOf = (id: SessionId): SessionRowView | undefined =>
    !archived.has(id) && Object.prototype.hasOwnProperty.call(byId, id) ? rowViewOf(byId[id]) : undefined

  const parentOf = (id: SessionId): SessionId | undefined => {
    // Ordinary native forks no longer expose parentId in current catalogs.
    // Prefer the persisted annotation; legacy remote-created ids also encode
    // the exact source id. Never infer lineage from titles or message text.
    const legacyFork = /^(.*)-fork-[a-z0-9]+-[a-z0-9]{6}$/u.exec(id)
    const encodedParent = legacyFork?.[1] as SessionId | undefined
    const parentId = viewOf(id)?.parentId ?? entries.get(id)?.parentId ?? encodedParent
    if (parentId === undefined || parentId === id) return undefined
    return viewOf(parentId) === undefined ? undefined : parentId
  }

  const rootChain: SessionId[] = []
  const walkSeen = new Set<SessionId>()
  for (let cursor: SessionId | undefined = sessionId; cursor !== undefined && !walkSeen.has(cursor); ) {
    walkSeen.add(cursor)
    rootChain.push(cursor)
    cursor = parentOf(cursor)
  }
  const rootId: SessionId = rootChain[rootChain.length - 1]!

  const ids = state.ids ?? (Object.keys(byId) as SessionId[])
  const orderOf = (id: SessionId): number => {
    const index = ids.indexOf(id)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }
  const createdAtOf = (id: SessionId): number => entries.get(id)?.createdAt ?? viewOf(id)?.updatedAt ?? 0

  // Permanent branch numbers. Archived rows stay in `byId` (they are only
  // filtered out of the visible topology), so numbering every Session of this
  // lineage — including archived ones — keeps a branch's number and colour
  // unchanged when an outer branch disappears. Numbers are never reused.
  const rawParentOf = (id: SessionId): SessionId | undefined => {
    const legacyFork = /^(.*)-fork-[a-z0-9]+-[a-z0-9]{6}$/u.exec(id)
    const encodedParent = legacyFork?.[1] as SessionId | undefined
    const parentId = rowViewOf(byId[id])?.parentId ?? entries.get(id)?.parentId ?? encodedParent
    return parentId === id ? undefined : parentId
  }
  const belongsToRoot = (id: SessionId): boolean => {
    const seen = new Set<SessionId>()
    for (let cursor: SessionId | undefined = id; cursor !== undefined && !seen.has(cursor); ) {
      if (cursor === rootId) return true
      seen.add(cursor)
      cursor = rawParentOf(cursor)
    }
    return false
  }
  // Only the persisted lineage timestamp is stable. Falling back to the
  // activity timestamp would renumber (and recolour) a branch whenever it
  // receives a message; unrecorded forks sort last by list order instead.
  const stableTimeOf = (id: SessionId): number =>
    entries.get(id)?.createdAt ?? Number.MAX_SAFE_INTEGER
  const branchNumberById = new Map<SessionId, number>()
  ;(Object.keys(byId) as SessionId[])
    .filter(id => id !== rootId
      && rowViewOf(byId[id])?.subagent !== true
      && rawParentOf(id) !== undefined
      && belongsToRoot(id))
    .sort((left, right) => stableTimeOf(left) - stableTimeOf(right) || orderOf(left) - orderOf(right))
    .forEach((id, index) => { branchNumberById.set(id, index + 1) })

  const childIds = new Map<SessionId, SessionId[]>()
  for (const id of Object.keys(byId) as SessionId[]) {
    if (archived.has(id)) continue
    const view = viewOf(id)
    if (view?.subagent === true) continue
    const parentId = parentOf(id)
    if (parentId === undefined) continue
    const siblings = childIds.get(parentId)
    if (siblings === undefined) childIds.set(parentId, [id])
    else siblings.push(id)
  }
  const siblingsOf = (parentId: SessionId): readonly SessionId[] =>
    (childIds.get(parentId) ?? []).slice().sort((a, b) => createdAtOf(a) - createdAtOf(b) || orderOf(a) - orderOf(b))

  interface TopologyRow {
    id: SessionId
    depth: number
    isLast: boolean
    railContinues: readonly boolean[]
  }
  const topology: TopologyRow[] = []
  const subtree = new Set<SessionId>()
  const visit = (
    siblings: readonly SessionId[],
    depth: number,
    railContinues: readonly boolean[],
    ancestors: ReadonlySet<SessionId>,
  ): void => {
    siblings.forEach((id, index) => {
      if (ancestors.has(id)) return
      const isLast = index === siblings.length - 1
      topology.push({ id, depth, isLast, railContinues })
      subtree.add(id)
      const nextAncestors = new Set(ancestors)
      nextAncestors.add(id)
      visit(siblingsOf(id), depth + 1, [...railContinues, !isLast], nextAncestors)
    })
  }
  visit([rootId], 0, [], new Set())

  const highlightedId: SessionId = state.current !== undefined && subtree.has(state.current) ? state.current : sessionId
  const activeAncestors = new Set<SessionId>()
  for (let cursor = highlightedId; cursor !== rootId; ) {
    const parentId = parentOf(cursor)
    if (parentId === undefined || activeAncestors.has(parentId)) break
    activeAncestors.add(parentId)
    cursor = parentId
  }

  const rows: BranchTreeRow[] = topology.map(({ id, depth, isLast, railContinues }) => {
    const entry = entries.get(id)
    const view = viewOf(id)
    return {
      sessionId: id,
      parentId: parentOf(id),
      title: entry?.summary ?? view?.displayTitle ?? id,
      depth,
      isLast,
      railContinues,
      childCount: siblingsOf(id).length,
      running: view?.running === true,
      current: id === highlightedId,
      onActivePath: id === highlightedId || activeAncestors.has(id),
      createdAt: createdAtOf(id),
      branchNumber: branchNumberById.get(id) ?? 0,
      badge: depth === 0 ? 'main' : entry !== undefined ? 'fork' : 'clone',
      branchLabel: entry?.branch,
    }
  })
  return { rows, rootId, highlightedId, activeAncestors }
}

/** Pre-order rows minus the descendants of collapsed rows. */
export function visibleBranchRows(
  rows: readonly BranchTreeRow[],
  collapsed: ReadonlySet<SessionId>,
): BranchTreeRow[] {
  const visible: BranchTreeRow[] = []
  let skipDepth = 0
  for (const row of rows) {
    if (skipDepth > 0 && row.depth >= skipDepth) continue
    skipDepth = 0
    visible.push(row)
    if (collapsed.has(row.sessionId)) skipDepth = row.depth + 1
  }
  return visible
}

function nodeSequence(node: TreeNode): number | undefined {
  const primary = node.metadata?.sessionEventSeq
  if (typeof primary === 'number' && Number.isSafeInteger(primary)) return primary
  const source = node.metadata?.sourceEventSeq
  return typeof source === 'number' && Number.isSafeInteger(source) ? source : undefined
}

function contentKey(node: TreeNode): string {
  const role = node.message?.role ?? node.type
  const text = (node.message?.content ?? node.summary ?? '').replace(/\s+/gu, ' ').trim()
  const images = (node.content ?? []).filter(part => part.type === 'image')
    .map(part => [part.attachmentId ?? null, part.mediaType ?? null])
  return `${role}\u0000${text}${images.length === 0 ? '' : `\u0000${JSON.stringify(images)}`}`
}

function matchKey(node: TreeNode): string {
  const seq = nodeSequence(node)
  return `${node.nodeId}\u0000${seq === undefined ? '' : String(seq)}`
}

function sameNode(left: TreeNode, right: TreeNode): boolean {
  return matchKey(left) === matchKey(right)
}

/** Root-to-selected/cursor path, with defensive fallback for sparse views. */
function pathToNode(view: SessionTreeView): TreeNode[] {
  const byId = new Map(view.nodes.map(node => [node.nodeId, node]))
  const preferred = view.selectedNodeId
  let current = typeof preferred === 'string' && byId.has(preferred)
    ? preferred
    : view.cursor !== null && byId.has(view.cursor)
      ? view.cursor
      : view.nodes.at(-1)?.nodeId ?? null
  const path: TreeNode[] = []
  const seen = new Set<string>()
  while (current !== null && !seen.has(current)) {
    seen.add(current)
    const node = byId.get(current)
    if (node === undefined) break
    path.push(node)
    current = node.parentId
  }
  return path.reverse()
}

/** First typed user prompt in a fork that its parent does not contain. */
export function firstUnsharedUserNode(child: SessionTreeView, parent: SessionTreeView): TreeNode | undefined {
  const parentTexts = new Set(parent.nodes
    .filter(node => node.message?.role === 'user' && !isInjectedUserNode(node))
    .map(node => contentKey(node)))
  return child.nodes.find(node => node.message?.role === 'user'
    && !isInjectedUserNode(node)
    && !parentTexts.has(contentKey(node)))
}

function placeholderNode(row: BranchTreeRow, kind: SessionGraphPlaceholder): TreeNode {
  return {
    nodeId: `__session-tree-${kind}__`,
    parentId: null,
    branch: 'main',
    type: 'custom',
    summary: row.title,
    createdAt: '',
    metadata: { sessionGraphPlaceholder: kind },
  }
}

function branchKey(sessionId: SessionId, anchorNodeId: string): string {
  return `${sessionId}:${anchorNodeId}`
}

function orderedViewNodes(view: SessionTreeView): readonly TreeNode[] {
  return view.nodes.slice().sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.nodeId.localeCompare(right.nodeId),
  )
}

/**
 * Merge every available Session view into one tree. The first Session row is
 * the trunk. Each child reconnects to the deepest matching root-path prefix
 * on its Session parent; that matched node is the fork point. A child whose
 * view is unavailable contributes one placeholder row and never fails the
 * rest of the graph.
 */
export function buildSessionGraphModel(
  topology: BranchTreeModel,
  views: ReadonlyMap<SessionId, SessionTreeView>,
  failed: ReadonlySet<SessionId>,
): SessionGraphModel {
  const graph = new Map<string, MutableGraphNode>()
  const sessionMaps = new Map<SessionId, ReadonlyMap<string, string>>()
  const sessionTails = new Map<SessionId, string>()
  const sessionBranchKeys = new Map<SessionId, readonly string[]>()
  const branchKeyBySession = new Map<SessionId, string>()
  const rowOrder = new Map(topology.rows.map((row, index) => [row.sessionId, index]))
  const failedSessionIds: SessionId[] = []

  const addNode = (
    key: string,
    node: TreeNode,
    parentKey: string | null,
    order: number,
    placeholder: SessionGraphPlaceholder | undefined,
  ): MutableGraphNode => {
    const existing = graph.get(key)
    if (existing !== undefined) {
      existing.order = Math.min(existing.order, order)
      return existing
    }
    const created: MutableGraphNode = {
      key,
      node,
      parentKey,
      owners: new Set(),
      ownerNodeIds: new Map(),
      badges: [],
      branchKeys: new Set(),
      order,
      placeholder,
    }
    graph.set(key, created)
    return created
  }

  const addOwner = (key: string, sessionId: SessionId, nodeId: string): void => {
    const target = graph.get(key)
    if (target === undefined) return
    target.owners.add(sessionId)
    target.ownerNodeIds.set(sessionId, nodeId)
  }

  const addBranchKeys = (key: string, keys: readonly string[]): void => {
    const target = graph.get(key)
    if (target === undefined) return
    for (const value of keys) target.branchKeys.add(value)
  }

  const addBadge = (
    key: string,
    row: BranchTreeRow,
    collapseKey: string,
    hasChildren: boolean,
  ): void => {
    const target = graph.get(key)
    if (target === undefined) return
    target.badges.push({
      sessionId: row.sessionId,
      kind: row.badge,
      branchLabel: row.branchLabel,
      title: row.title,
      running: row.running,
      current: row.current,
      collapseKey,
      hasChildren,
    })
  }

  const mergeSession = (row: BranchTreeRow, order: number): void => {
    const nodeKeys = new Map<string, string>()
    const view = views.get(row.sessionId)
    const parentId = row.parentId
    const parentView = parentId === undefined ? undefined : views.get(parentId)
    const parentKeys = parentId === undefined ? undefined : sessionMaps.get(parentId)
    const fallbackParentKey = parentId === undefined ? null : sessionTails.get(parentId) ?? null
    const inheritedBranchKeys = parentId === undefined ? [] : sessionBranchKeys.get(parentId) ?? []

    if (view === undefined || failed.has(row.sessionId)) {
      const kind: SessionGraphPlaceholder = failed.has(row.sessionId) ? 'error' : 'loading'
      const key = `${row.sessionId}:__session-tree-${kind}__`
      const node = placeholderNode(row, kind)
      const collapseKey = branchKey(row.sessionId, node.nodeId)
      addNode(key, node, fallbackParentKey, order, kind)
      addOwner(key, row.sessionId, node.nodeId)
      addBranchKeys(key, [...inheritedBranchKeys, collapseKey])
      addBadge(key, row, collapseKey, false)
      sessionMaps.set(row.sessionId, new Map([[node.nodeId, key]]))
      sessionTails.set(row.sessionId, key)
      sessionBranchKeys.set(row.sessionId, [...inheritedBranchKeys, collapseKey])
      branchKeyBySession.set(row.sessionId, collapseKey)
      if (kind === 'error') failedSessionIds.push(row.sessionId)
      return
    }

    const childPath = pathToNode(view)
    const sharedChildIds = new Set<string>()
    const sharedParentKeys = new Map<string, string>()
    if (parentView !== undefined && parentKeys !== undefined) {
      // A fork copies node identities, not just the currently selected path.
      // Dedup by identity so a parent whose cursor sits on an older node does
      // not turn the child's copied tail into duplicate rows.
      // Renumbered forks can reuse a node id whose seq happens to point at a
      // DIFFERENT parent message; identity alone is only trusted when the
      // content also matches.
      const parentKeyByMatch = new Map<string, string>()
      for (const parentNode of parentView.nodes) {
        const key = parentKeys.get(parentNode.nodeId)
        if (key !== undefined) parentKeyByMatch.set(`${matchKey(parentNode)}\u0000${contentKey(parentNode)}`, key)
      }
      for (const childNode of view.nodes) {
        const parentKey = parentKeyByMatch.get(`${matchKey(childNode)}\u0000${contentKey(childNode)}`)
        if (parentKey === undefined) continue
        sharedChildIds.add(childNode.nodeId)
        sharedParentKeys.set(childNode.nodeId, parentKey)
      }
      // A fork copies nodes with renumbered event seqs, and older seeds kept
      // only the selected user path — so the child's prompts can be a
      // SUBSEQUENCE of the parent's, not a strict prefix. Align monotonically
      // by content; a dropped middle prompt must not split the rest into
      // duplicate rows.
      const parentOrder = orderedViewNodes(parentView)
      const childOrder = orderedViewNodes(view)
      const keyAt = new Map<string, number>()
      parentOrder.forEach((parentNode, index) => {
        const parentKey = parentKeys.get(parentNode.nodeId)
        if (parentKey !== undefined) keyAt.set(parentKey, index)
      })
      const contentOf = new WeakMap<TreeNode, string>()
      const text = (node: TreeNode): string => {
        // Key by node object: renumbered forks can reuse ids across views.
        const cached = contentOf.get(node)
        if (cached !== undefined) return cached
        const value = contentKey(node)
        contentOf.set(node, value)
        return value
      }
      let cursor = 0
      for (const childNode of childOrder) {
        const identityKey = sharedParentKeys.get(childNode.nodeId)
        if (identityKey !== undefined) {
          const at = keyAt.get(identityKey)
          if (at !== undefined && at >= cursor) cursor = at + 1
          continue
        }
        const needle = text(childNode)
        let found = -1
        for (let index = cursor; index < parentOrder.length; index += 1) {
          if (text(parentOrder[index]!) === needle) { found = index; break }
        }
        if (found === -1) continue
        const parentKey = parentKeys.get(parentOrder[found]!.nodeId)
        if (parentKey === undefined) continue
        sharedChildIds.add(childNode.nodeId)
        sharedParentKeys.set(childNode.nodeId, parentKey)
        cursor = found + 1
      }
    }

    for (const node of view.nodes) {
      nodeKeys.set(node.nodeId, sharedParentKeys.get(node.nodeId) ?? `${row.sessionId}:${node.nodeId}`)
    }

    const anchorNodeId = childPath.at(-1) !== undefined && sharedChildIds.has(childPath.at(-1)!.nodeId)
      ? childPath.filter(node => sharedChildIds.has(node.nodeId)).at(-1)?.nodeId
      : undefined
    const rootAnchorNodeId = childPath[0]?.nodeId ?? orderedViewNodes(view)[0]?.nodeId ?? '__root__'
    const ownBranchKey = branchKey(row.sessionId, anchorNodeId ?? rootAnchorNodeId)
    const branchKeys = [...inheritedBranchKeys, ownBranchKey]
    sessionBranchKeys.set(row.sessionId, branchKeys)
    branchKeyBySession.set(row.sessionId, ownBranchKey)

    for (const node of view.nodes) {
      const key = nodeKeys.get(node.nodeId)
      if (key === undefined) continue
      const parentKey = node.parentId === null
        ? fallbackParentKey
        : nodeKeys.get(node.parentId) ?? fallbackParentKey
      addNode(
        key,
        node,
        sharedParentKeys.has(node.nodeId) ? graph.get(key)?.parentKey ?? parentKey : parentKey,
        order,
        undefined,
      )
      addOwner(key, row.sessionId, node.nodeId)
      if (!sharedChildIds.has(node.nodeId)) addBranchKeys(key, branchKeys)
    }

    if (view.nodes.length === 0) {
      const kind: SessionGraphPlaceholder = 'empty'
      const key = `${row.sessionId}:__session-tree-empty__`
      const node = placeholderNode(row, kind)
      const collapseKey = branchKey(row.sessionId, node.nodeId)
      addNode(key, node, fallbackParentKey, order, kind)
      addOwner(key, row.sessionId, node.nodeId)
      addBranchKeys(key, [...branchKeys, collapseKey])
      addBadge(key, row, collapseKey, false)
      sessionMaps.set(row.sessionId, new Map([[node.nodeId, key]]))
      sessionTails.set(row.sessionId, key)
      sessionBranchKeys.set(row.sessionId, [...branchKeys, collapseKey])
      branchKeyBySession.set(row.sessionId, collapseKey)
      return
    }

    const unsharedNodes = view.nodes.filter(node => !sharedChildIds.has(node.nodeId))
    // A newly created fork may contain only the inherited prefix. Keep the
    // copied messages shared, but give the real Session a separate endpoint:
    // otherwise its badge is painted on the trunk and no fork lane exists.
    if (row.parentId !== undefined && unsharedNodes.length === 0) {
      const inheritedTail = view.nodes.at(-1)
      const anchor = inheritedTail === undefined ? fallbackParentKey : nodeKeys.get(inheritedTail.nodeId) ?? fallbackParentKey
      // Sort the empty fork by when the Session itself was created, not by
      // the inherited anchor node: the row must stay in true time order even
      // though it only carries a display endpoint.
      const node = {
        ...placeholderNode(row, 'fork'),
        createdAt: row.createdAt !== undefined && row.createdAt > 0
          ? new Date(row.createdAt).toISOString()
          : inheritedTail?.createdAt ?? '',
      }
      const key = `${row.sessionId}:${node.nodeId}`
      addNode(key, node, anchor, order, 'fork')
      addOwner(key, row.sessionId, node.nodeId)
      addBranchKeys(key, branchKeys)
      addBadge(key, row, ownBranchKey, false)
      sessionMaps.set(row.sessionId, nodeKeys)
      // Descendants inherit real messages, never this display-only endpoint.
      sessionTails.set(row.sessionId, anchor ?? key)
      return
    }
    const badgeNode = row.parentId === undefined
      ? childPath[0] ?? orderedViewNodes(view)[0]
      : childPath.find(node => !sharedChildIds.has(node.nodeId))
        ?? orderedViewNodes(view).find(node => !sharedChildIds.has(node.nodeId))
        ?? childPath.at(-1)
    const badgeKey = badgeNode === undefined ? undefined : nodeKeys.get(badgeNode.nodeId)
    const collapseKey = ownBranchKey ?? branchKey(row.sessionId, badgeNode?.nodeId ?? '__root__')
    if (badgeKey !== undefined) addBadge(badgeKey, row, collapseKey, unsharedNodes.length > 0)

    const tailNode = childPath.at(-1) ?? orderedViewNodes(view).at(-1)
    const tailKey = tailNode === undefined ? fallbackParentKey : nodeKeys.get(tailNode.nodeId) ?? fallbackParentKey
    sessionMaps.set(row.sessionId, nodeKeys)
    sessionTails.set(row.sessionId, tailKey ?? fallbackParentKey ?? `${row.sessionId}:__session-tree-empty__`)
  }

  topology.rows.forEach((row, order) => { mergeSession(row, order) })

  const children = new Map<string, string[]>()
  const rootKeys = new Set<string>()
  for (const node of graph.values()) {
    if (node.parentKey === null || !graph.has(node.parentKey)) {
      rootKeys.add(node.key)
      continue
    }
    const siblings = children.get(node.parentKey)
    if (siblings === undefined) children.set(node.parentKey, [node.key])
    else siblings.push(node.key)
  }
  const compareKeys = (leftKey: string, rightKey: string): number => {
    const left = graph.get(leftKey)!
    const right = graph.get(rightKey)!
    return left.order - right.order
      || left.node.createdAt.localeCompare(right.node.createdAt)
      || left.key.localeCompare(right.key)
  }
  for (const siblings of children.values()) siblings.sort(compareKeys)
  const sortedRoots = [...rootKeys].sort(compareKeys)

  const currentView = views.get(topology.highlightedId)
  const currentKeys = sessionMaps.get(topology.highlightedId)
  const activePathKeys = new Set<string>()
  const currentSelectedNode = currentView === undefined
    ? undefined
    : currentView.nodes.find(node => node.nodeId === (currentView.selectedNodeId ?? currentView.cursor))
  if (currentView !== undefined && currentKeys !== undefined) {
    for (const node of pathToNode(currentView)) {
      const key = currentKeys.get(node.nodeId)
      if (key !== undefined) activePathKeys.add(key)
    }
  }

  const laneFor = (index: number): number => ((index % 5) + 5) % 5
  const rows: SessionGraphRow[] = []
  const visited = new Set<string>()
  const visit = (
    key: string,
    lane: number,
    parentLane: number | null,
    inheritedRails: readonly number[],
    ancestors: ReadonlySet<string>,
  ): void => {
    if (visited.has(key) || ancestors.has(key)) return
    const node = graph.get(key)
    if (node === undefined) return
    const nodeChildren = children.get(key) ?? []
    const continues = [...new Set(inheritedRails)].filter(value => value !== lane)
    const currentSelected = currentView?.selectedNodeId ?? currentView?.cursor ?? null
    rows.push({
      key,
      parentKey: node.parentKey,
      node: node.node,
      owners: [...node.owners].sort((a, b) => (rowOrder.get(a) ?? 0) - (rowOrder.get(b) ?? 0)),
      ownerNodeIds: node.ownerNodeIds,
      badges: node.badges,
      lane,
      parentLane,
      continues,
      // The expander is a fork control: show it only when this node
      // actually splits into more than one visible child.
      hasChildren: nodeChildren.length > 1,
      branchKeys: [...node.branchKeys],
      branchOutLanes: [],
      branchOutColors: [],
      continueColors: [],
      colorIndex: 0,
      laneShiftFrom: null,
      // Compare the highlighted Session's OWN node id: renumbered forks reuse
      // ids for different content, so the merged id alone selects two rows.
      active: node.owners.has(topology.highlightedId)
        && currentSelected !== null
        && (node.ownerNodeIds.get(topology.highlightedId) ?? node.node.nodeId) === currentSelected
        // Renumbered forks reuse ids for different content; also require the
        // same text so only the row the user actually selected is highlighted.
        && currentSelectedNode !== undefined
        && contentKey(node.node) === contentKey(currentSelectedNode),
      onActivePath: activePathKeys.has(key)
        || (node.placeholder !== undefined && node.owners.has(topology.highlightedId)),
      placeholder: node.placeholder,
    })
    visited.add(key)
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(key)
    nodeChildren.forEach((childKey, index) => {
      const childLane = index === 0 ? lane : laneFor(lane + index)
      const laterRails = nodeChildren
        .slice(index + 1)
        .map((_, siblingIndex) => laneFor(lane + index + siblingIndex + 1))
      visit(
        childKey,
        childLane,
        lane,
        [
          ...inheritedRails,
          ...(index < nodeChildren.length - 1 ? [lane] : []),
          ...laterRails,
        ],
        nextAncestors,
      )
    })
  }
  sortedRoots.forEach((key, index) => { visit(key, laneFor(index), null, [], new Set()) })

  const activeBranchKeys = new Set<string>()
  for (const sessionId of [...topology.activeAncestors, topology.highlightedId]) {
    const key = branchKeyBySession.get(sessionId)
    if (key !== undefined) activeBranchKeys.add(key)
  }

  // Merge every branch into one chronological transcript: order by the node's
  // own timestamp (oldest first) while keeping each parent above its children.
  // A plain sort could place a child before its fork point, so use Kahn's
  // algorithm with a time-ordered ready set.
  const baseRows = rows
  const rowByKey = new Map(baseRows.map(row => [row.key, row]))
  const indegree = new Map<string, number>()
  const childrenByParent = new Map<string, string[]>()
  for (const row of baseRows) {
    indegree.set(row.key, 0)
  }
  for (const row of baseRows) {
    if (row.parentKey === null || !rowByKey.has(row.parentKey)) continue
    indegree.set(row.key, (indegree.get(row.key) ?? 0) + 1)
    const siblings = childrenByParent.get(row.parentKey)
    if (siblings === undefined) childrenByParent.set(row.parentKey, [row.key])
    else siblings.push(row.key)
  }
  const laneShiftFrom = (from: number | null, to: number): number | null =>
    from === null || from === to ? null : from
  const compareTime = (left: string, right: string): number => {
    const leftRow = rowByKey.get(left)!
    const rightRow = rowByKey.get(right)!
    return leftRow.node.createdAt.localeCompare(rightRow.node.createdAt)
      || (rowOrder.get(leftRow.owners[0] ?? topology.rootId) ?? 0)
        - (rowOrder.get(rightRow.owners[0] ?? topology.rootId) ?? 0)
      || left.localeCompare(right)
  }
  const ready = baseRows
    .filter(row => (indegree.get(row.key) ?? 0) === 0)
    .map(row => row.key)
  ready.sort(compareTime)
  const chronological: SessionGraphRow[] = []
  while (ready.length > 0) {
    const key = ready.shift()!
    const row = rowByKey.get(key)
    if (row !== undefined) chronological.push(row)
    for (const childKey of childrenByParent.get(key) ?? []) {
      const next = (indegree.get(childKey) ?? 0) - 1
      indegree.set(childKey, next)
      if (next === 0) {
        ready.push(childKey)
        ready.sort(compareTime)
      }
    }
  }
  // Defensive: cycles/missing parents must not drop rows.
  for (const row of baseRows) {
    if (!chronological.includes(row)) chronological.push(row)
  }

  // Requirement (2026-11-08 22:58): lanes are numbered left to right
  // 1..max, the main line is lane 0, and the branch created first sits at
  // MAX (rightmost). Branch 2 takes max-1, branch 3 takes max-2, and so on.
  // Ordering by creation time (not by the first row that happens to appear)
  // keeps the numbering stable when an empty fork row sorts early.
  const forkRows = topology.rows
    .filter(row => row.parentId !== undefined)
    .slice()
    .sort((left, right) =>
      (left.createdAt ?? 0) - (right.createdAt ?? 0)
      || (rowOrder.get(left.sessionId) ?? 0) - (rowOrder.get(right.sessionId) ?? 0),
    )
  const laneByBranch = new Map<SessionId, number>([[topology.rootId, 0]])
  const colorByBranch = new Map<SessionId, number>([[topology.rootId, 0]])
  forkRows.forEach((row, index) => {
    // Colour follows the permanent branch number, never the visible position.
    // Archiving an outer branch must not hand its colour to the next branch.
    const branchNumber = row.branchNumber !== undefined && row.branchNumber > 0
      ? row.branchNumber
      : index + 1
    colorByBranch.set(row.sessionId, ((branchNumber - 1) % 8) + 1)
  })

  // Top-level branches keep the established rule: first-created at max,
  // then max-1, all the way to lane 1. Lanes never wrap through laneFor —
  // with 5 branches the first branch is lane 5, and a modulo would fold it
  // onto lane 0 (the main line), hiding the branch under the trunk.
  const topLevelRows = forkRows.filter(row => row.depth === 1)
  topLevelRows.forEach((row, index) => {
    laneByBranch.set(row.sessionId, topLevelRows.length - index)
  })

  // A fork of a fork inherits its parent's lane and takes the next outer
  // lane (parent + 1). Inserting the child shifts every outer lane by one so
  // the child stays adjacent to its parent instead of jumping to lane 1.
  const siblingCount = new Map<SessionId, number>()
  const nestedRows = forkRows
    .filter(row => row.depth > 1)
    .slice()
    .sort((left, right) => left.depth - right.depth
      || (left.createdAt ?? 0) - (right.createdAt ?? 0)
      || (rowOrder.get(left.sessionId) ?? 0) - (rowOrder.get(right.sessionId) ?? 0))
  for (const row of nestedRows) {
    const parentId = row.parentId
    if (parentId === undefined) continue
    const parentLane = laneByBranch.get(parentId)
    if (parentLane === undefined) continue
    const index = siblingCount.get(parentId) ?? 0
    siblingCount.set(parentId, index + 1)
    const desired = parentLane + index + 1
    for (const [sessionId, lane] of laneByBranch) {
      if (lane >= desired) laneByBranch.set(sessionId, lane + 1)
    }
    laneByBranch.set(row.sessionId, desired)
  }
  const laneAssigned = chronological.map(row => {
    const primary = row.owners[0] ?? topology.rootId
    return {
      ...row,
      lane: laneByBranch.get(primary) ?? row.lane,
      colorIndex: colorByBranch.get(primary) ?? 0,
      laneShiftFrom: null,
    }
  })
  const laneByKeyAfter = new Map(laneAssigned.map(row => [row.key, row.lane]))
  const shiftedRows = laneAssigned.map(row => ({
    ...row,
    parentLane: row.parentKey === null ? null : laneByKeyAfter.get(row.parentKey) ?? row.parentLane,
  }))

  // Keep interleaved branches visually connected: a lane stays open from the
  // row that spawns a child down to that child's row, so pass-through lines
  // cross every row in between without changing parent/child relations.
  const laneOfKey = new Map(shiftedRows.map(row => [row.key, row.lane]))
  const childLanesByParent = new Map<string, number[]>()
  for (const row of shiftedRows) {
    if (row.parentKey === null) continue
    const lanes = childLanesByParent.get(row.parentKey) ?? []
    if (row.lane !== laneOfKey.get(row.parentKey)) lanes.push(row.lane)
    childLanesByParent.set(row.parentKey, lanes)
  }
  const remaining = new Map<number, number>()
  for (const row of shiftedRows) remaining.set(row.lane, (remaining.get(row.lane) ?? 0) + 1)
  const openLanes = new Set<number>()
  const connected = shiftedRows.map(row => {
    const inherited = [...openLanes].sort((left, right) => left - right)
    const left = (remaining.get(row.lane) ?? 0) - 1
    remaining.set(row.lane, left)
    if (left <= 0) openLanes.delete(row.lane)
    for (const childKey of childrenByParent.get(row.key) ?? []) {
      const childLane = laneOfKey.get(childKey)
      if (childLane !== undefined) openLanes.add(childLane)
    }
    return {
      ...row,
      branchOutLanes: [...new Set(childLanesByParent.get(row.key) ?? [])],
      // Rails exclude the row's own lane: its edge already draws that lane.
      continues: inherited.filter(lane => lane !== row.lane),
    }
  })

  // Bind colours to the branch that owns each lane, then derive every rail and
  // fork edge from that map. This keeps a lane's line exactly the colour of the
  // circles on it, regardless of row order or branch nesting.
  const laneColorOf = new Map<number, number>()
  for (const row of connected) {
    if (!laneColorOf.has(row.lane)) laneColorOf.set(row.lane, row.colorIndex)
  }
  const colored = connected.map(row => ({
    ...row,
    branchOutColors: row.branchOutLanes.map(lane => laneColorOf.get(lane) ?? lane),
    continueColors: row.continues.map(lane => laneColorOf.get(lane) ?? lane),
  }))

  return {
    rows: colored,
    sessionIds: topology.rows.map(row => row.sessionId),
    failedSessionIds,
    highlightedId: topology.highlightedId,
    activePathKeys,
    activeBranchKeys,
  }
}
