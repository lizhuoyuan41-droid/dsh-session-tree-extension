/**
 * SessionTreePanel fills DeepSeek Harness' right details sidebar.
 *
 * The modern host path merges every Session in the current lineage into one
 * git-style graph. Selector mode and older hosts keep the original
 * single-Session view. Both paths use a fixed-width graph gutter, so tree
 * depth can never increase the panel's horizontal width.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  LlmRole,
  SessionTreeForkView,
  SessionTreeView,
  TreeNode,
} from '@ryanlee2007/dsh-pi-agent-session-tree/client'
import type { SessionTreeViewProps } from './slots.ts'
import type { SessionTreeKey } from './locales.ts'
import { isInjectedUserNode, nodeFullText } from './node-text.ts'
import {
  buildBranchTreeModel,
  buildSessionGraphModel,
  firstUnsharedUserNode,
  focusSessionGraph,
  type SessionGraphBadge,
  type SessionGraphPlaceholder,
  type SessionGraphRow,
} from './session-graph.ts'
import css from './SessionTreePanel.module.css'
import { SESSION_TREE_VERSION } from './version.ts'
import { currentSessionId } from './session-list.ts'
import { LaneEdges } from './LaneEdges.tsx'
import { attachRailScrollSync } from './node-navigation.ts'
import { navigationStatus, rememberedSelection, subscribeNavigationStatus, subscribeSelection } from './navigation-store.ts'
import { requestNodeNavigation } from './navigation-request.ts'
import { rememberBranchTopic } from './branch-topic.ts'
import type { ForkLineageEntry } from './fork-lineage.ts'
import { focusKeySnapshot, setFocusKey, subscribeFocusKey } from './focus-store.ts'

const ROLE_LABELS: Record<LlmRole, SessionTreeKey> = {
  system: 'node.role.system',
  user: 'node.role.user',
  assistant: 'node.role.assistant',
  tool: 'node.role.tool',
}
const GRAPH_LANES = 5
// Branch columns need breathing room; lane count grows with dynamic insertion.
const laneX = (lane: number): number => 14 + lane * 15
const FAN_OUT_DEBOUNCE_MS = 80
// Branch lane palette: main first, then fork lanes left to right.
// Index 0 is the main line; 1..8 are permanent branch colours. A branch's
// colour index is derived from its stable branch number, so archiving an
// outer branch never shifts colours onto its neighbours.
const LANE_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#a855f7', '#ef4444',
  '#6366f1', '#84cc16', '#f97316', '#06b6d4',
] as const

const EMPTY_MODE_SNAPSHOT = { selectorOpen: false } as const
const NOOP_SUBSCRIBE = (_listener: () => void): (() => void) => () => {}
const EMPTY_ARCHIVES: readonly SessionId[] = []
const NOOP_GET_MODE_SNAPSHOT = (): typeof EMPTY_MODE_SNAPSHOT => EMPTY_MODE_SNAPSHOT
const EMPTY_LINEAGE = new Map<SessionId, never>()
const EMPTY_LINEAGE_SNAPSHOT = (): typeof EMPTY_LINEAGE => EMPTY_LINEAGE
const EMPTY_COLLAPSED: ReadonlySet<string> = new Set()

interface GraphRow {
  readonly node: TreeNode
  readonly lane: number
  readonly parentLane: number | null
  readonly continues: readonly number[]
  readonly branchOutLanes: readonly number[]
  readonly branchOutColors: readonly number[]
  readonly continueColors: readonly number[]
  readonly colorIndex: number
  readonly laneShiftFrom: number | null
}

/** Flatten the topology once. Lanes are bounded and reused; depth never becomes padding. */
function graphRows(nodes: readonly TreeNode[]): GraphRow[] {
  const children = new Map<string | null, TreeNode[]>()
  for (const node of nodes) {
    const siblings = children.get(node.parentId)
    if (siblings === undefined) children.set(node.parentId, [node])
    else siblings.push(node)
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.nodeId.localeCompare(b.nodeId))
  }
  const rows: GraphRow[] = []
  const visit = (
    parentId: string | null,
    parentLane: number | null,
    lane: number,
    ancestors: ReadonlySet<string>,
  ): void => {
    const siblings = children.get(parentId) ?? []
    siblings.forEach((node, index) => {
      if (ancestors.has(node.nodeId)) return
      const nodeLane = parentId === null ? 0 : index === 0 ? lane : (lane + index) % GRAPH_LANES
      const next = new Set(ancestors)
      next.add(node.nodeId)
      const continues = parentLane === null ? [] : [parentLane]
      rows.push({
        node, lane: nodeLane, parentLane, continues,
        branchOutLanes: [], branchOutColors: [], continueColors: [],
        colorIndex: nodeLane, laneShiftFrom: null,
      })
      visit(node.nodeId, nodeLane, nodeLane, next)
    })
  }
  visit(null, null, 0, new Set())
  return rows
}

/** Whether one node is a typed human prompt the fork selector may target. */
function isUserPromptNode(node: TreeNode): boolean {
  return node.message?.role === 'user' && !isInjectedUserNode(node)
}

/**
 * Remove hidden entries while preserving the visible tree topology: children
 * of a removed node reconnect to its nearest visible ancestor. The panel shows
 * typed human prompts only — assistant, tool and injected-context nodes stay
 * in the projection (navigation and the model path still use them) but are not
 * rendered. The fork selector passes the same prompt predicate.
 */
function projectVisibleNodes(
  nodes: readonly TreeNode[],
  isVisible: (node: TreeNode) => boolean = isUserPromptNode,
): readonly TreeNode[] {
  if (nodes.every(isVisible)) return nodes
  const byId = new Map(nodes.map(node => [node.nodeId, node]))
  const visibleIds = new Set(nodes.filter(isVisible).map(node => node.nodeId))
  const resolveParent = (node: TreeNode): string | null => {
    const seen = new Set<string>()
    let parentId = node.parentId
    while (parentId !== null && !seen.has(parentId)) {
      if (visibleIds.has(parentId)) return parentId
      seen.add(parentId)
      parentId = byId.get(parentId)?.parentId ?? null
    }
    return null
  }
  // Within one branch the log is a single chain: connect each visible node to
  // the previous visible node instead of preserving the raw assistant/tool
  // parents. Keeping the raw parents would turn a jump-seeded continuation
  // (two user prompts hanging off the same ancestor) into a phantom fork lane.
  // A node on a different branch keeps its real fork parent so explicit
  // /tree fork branches still render as lanes.
  const lastByBranch = new Map<string, TreeNode>()
  return nodes
    .filter(isVisible)
    .map(node => {
      const branch = node.branch ?? 'main'
      const previous = lastByBranch.get(branch)
      lastByBranch.set(branch, node)
      const parentId = previous !== undefined
        ? previous.nodeId
        : node.parentId === null ? null : resolveParent(node)
      return { ...node, parentId }
    })
}

/** Project one Session view without mutating the payload returned by load(). */
function projectVisibleView(view: SessionTreeView): SessionTreeView {
  const nodes = projectVisibleNodes(view.nodes)
  if (nodes === view.nodes) return view
  const nodeIds = new Set(nodes.map(node => node.nodeId))
  return {
    ...view,
    nodes,
    branches: view.branches.map(branch => ({
      ...branch,
      nodeIds: branch.nodeIds.filter(nodeId => nodeIds.has(nodeId)),
    })),
  }
}

function placeholderKey(kind: SessionGraphPlaceholder): SessionTreeKey {
  if (kind === 'fork') return 'panel.graph.fork'
  return kind === 'error'
    ? 'panel.graph.error'
    : kind === 'empty'
      ? 'panel.graph.empty'
      : 'panel.graph.loading'
}

/** The tool name carried by a tool-call node, used as the role label before its result lands. */
function toolNameOf(node: TreeNode): string | undefined {
  for (const part of node.content ?? []) {
    if (part.type === 'tool_call') return part.name
  }
  return undefined
}

/** Whether one node is a tool interaction entry (call, result, or merged pair). */
function isToolNode(node: TreeNode): boolean {
  return node.type === 'tool_call' || node.type === 'tool_result' || node.message?.role === 'tool'
}

/** Whether a node records a failed call — the row is marked red. */
function nodeHasError(node: TreeNode): boolean {
  return node.error !== undefined
    || node.content?.some(part => part.type === 'tool_result' && part.isError === true) === true
}

/** Fixed-width IDEA-style graph gutter shared by legacy and merged modes. */
function Graph({
  row,
  selected,
  markerOnly = false,
}: {
  row: GraphRow
  selected: boolean
  onActivePath: boolean
  markerOnly?: boolean
}) {
  const x = laneX(row.lane)
  const laneColor = LANE_COLORS[row.colorIndex % LANE_COLORS.length]
  // Outer radius including the stroke: lines meet the circle edge exactly.
  const dotRadius = selected ? 8.5 : 6.5
  const left = (value: number): string => `${value}px`
  return (
    <div
      className={css.laneColumn}
      data-lane-column
      data-lane={row.lane}
      style={{ ['--dot-r' as string]: `${dotRadius}px` }}
    >
      {markerOnly ? null : <>
      {row.continues.map((lanePath, index) => (
        <span
          key={lanePath}
          className={css.laneRail}
          style={{
            left: left(laneX(lanePath)),
            background: LANE_COLORS[(row.continueColors[index] ?? lanePath) % LANE_COLORS.length],
          }}
        />
      ))}
      {row.laneShiftFrom === null ? null : (
        <span
          className={css.laneShift}
          style={{
            left: left(Math.min(laneX(row.laneShiftFrom), x)),
            width: `${Math.abs(x - laneX(row.laneShiftFrom))}px`,
            background: laneColor,
          }}
        />
      )}
      {/* Every branch edge belongs to THIS row and leaves from the circle's
          bottom edge, then eases into its lane without a right angle. */}
      {row.branchOutLanes.map((lanePath, index) => {
        const laneXOut = laneX(lanePath)
        const path = `M ${x} 0 C ${x} 30 ${laneXOut} 30 ${laneXOut} 55 V 100`
        // Stagger multiple forks from one node so each branch has its own
        // take-off point instead of sharing one fork segment.
        const stagger = index * 7
        return (
          <svg
            key={`out-${lanePath}`}
            className={css.laneCurve}
            viewBox="0 0 300 100"
            preserveAspectRatio="none"
            aria-hidden="true"
            style={{
              top: `calc(50% + var(--dot-r) + ${stagger}px)`,
              height: `calc(50% - var(--dot-r) - ${stagger}px)`,
            }}
          >
            <path
              d={path}
              fill="none"
              stroke={LANE_COLORS[(row.branchOutColors[index] ?? lanePath) % LANE_COLORS.length]}
              strokeWidth="1.5"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )
      })}
      <span
        className={css.laneStem}
        style={{ left: left(x), background: laneColor, top: 0, bottom: 'calc(50% - var(--dot-r))' }}
      />
      <span
        className={css.laneTail}
        style={{ left: left(x), background: laneColor, top: 'calc(50% + var(--dot-r))', bottom: 0 }}
      />
      </>}
      <svg
        data-node-marker
        className={selected ? css.laneDotActive : css.laneDot}
        width={selected ? 17 : 13}
        height={selected ? 17 : 13}
        viewBox={selected ? '0 0 17 17' : '0 0 13 13'}
        style={{ left: left(x) }}
        aria-hidden="true"
      >
        <circle
          cx={selected ? 8.5 : 6.5}
          cy={selected ? 8.5 : 6.5}
          r={selected ? 7.25 : 5.75}
          fill={selected ? laneColor : 'var(--dsw-alias-bg-base)'}
          stroke={laneColor}
          strokeWidth={selected ? 2.5 : 1.5}
        />
      </svg>
    </div>
  )
}

/** Navigate the transcript through the built-in turn rail, then scroll. */
function scrollConversationToNode(node: TreeNode): void {
  if (typeof document === 'undefined') return
  const turn = node.metadata?.turn
  if (typeof turn === 'number') {
    const mark = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
      .find(button => {
        const label = button.getAttribute('aria-label') ?? ''
        const match = /(?:跳转到第|加载并跳转到第|Jump to turn)\s*(\d+)|第\s*(\d+)\s*轮/u.exec(label)
        if (match === null) return false
        const value = Number(match[1] ?? match[2])
        return value === turn && /跳转|Jump/u.test(label)
      })
    if (mark !== undefined) { mark.click(); return }
    const anchors = [...document.querySelectorAll<HTMLElement>('[data-chat-turn]')]
      .filter(row => row.closest('[aria-label="会话树"]') === null)
    const exact = anchors.find(row => Number(row.dataset.chatTurn) === turn)
    const nearest = exact ?? anchors
      .filter(row => Number.isFinite(Number(row.dataset.chatTurn)))
      .sort((left, right) => Math.abs(Number(left.dataset.chatTurn) - turn) - Math.abs(Number(right.dataset.chatTurn) - turn))[0]
    if (nearest !== undefined) { nearest.scrollIntoView({ block: 'start', behavior: 'smooth' }); return }
  }
  const needle = nodeFullText(node).replace(/\s+/gu, ' ').trim().slice(0, 48)
  if (needle.length < 4) return
  const panel = document.querySelector('[aria-label="会话树"]')
  const candidates = [...document.querySelectorAll<HTMLElement>('main *, [class*="conversation"] *')]
  let best: HTMLElement | undefined
  for (const element of candidates) {
    if (panel?.contains(element) === true) continue
    const text = (element.textContent ?? '').replace(/\s+/gu, ' ').trim()
    if (!text.includes(needle)) continue
    if (best === undefined || text.length < (best.textContent ?? '').length) best = element
  }
  if (typeof best?.scrollIntoView === 'function') best.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function badgeText(badge: SessionGraphBadge, t: (key: SessionTreeKey) => string): string {
  return badge.kind === 'main'
    ? t('branch.tree.main')
    : badge.kind === 'fork'
      ? t('branch.node.forkBadge')
      : t('branch.tree.cloneBadge')
}

function badgeClass(badge: SessionGraphBadge): string | undefined {
  return badge.kind === 'main'
    ? css.mainBadge
    : badge.kind === 'fork'
      ? css.forkBadge
      : css.cloneBadge
}

function PlaceholderText({
  kind,
  t,
}: {
  kind: SessionGraphPlaceholder
  t: (key: SessionTreeKey) => string
}) {
  return <>{t(placeholderKey(kind))}</>
}

/**
 * One render-ready row. Badge controls live in a separate content wrapper
 * above the node-selection button so controls never nest inside each other.
 */
/** Native `IconBranchOutlineRegular` silhouette: a stem splitting into two rounds. */
function BranchIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.4 8h3" />
      <path d="m5.4 8 3.2-3.2" />
      <path d="m5.4 8 3.2 3.2" />
      <circle cx="10.6" cy="3.6" r="1.6" />
      <circle cx="10.6" cy="12.4" r="1.6" />
    </svg>
  )
}

/** Focus a fork point: keep only its subtree. */
function FocusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="4.2" />
      <path d="M8 1.2v2.4M8 12.4v2.4M1.2 8h2.4M12.4 8h2.4" />
    </svg>
  )
}

function NodeRow({
  rowKey,
  node,
  markerOnly = false,
  edgeSpace,
  lane,
  parentLane,
  continues,
  branchOutLanes,
  branchOutColors,
  continueColors,
  colorIndex,
  laneShiftFrom,
  owners,
  badges,
  placeholder,
  selected,
  onActivePath,
  branchHeads,
  hasChildren,
  expanded,
  selectorMode,
  pending,
  showFork,
  showFocus,
  branchCollapsed,
  onToggleNode,
  onToggleBranch,
  onSelect,
  onFork,
  onFocus,
  onForkUserPrompt,
  t,
}: {
  rowKey: string
  node: TreeNode
  markerOnly?: boolean
  edgeSpace?: number | undefined
  lane: number
  parentLane: number | null
  continues: readonly number[]
  branchOutLanes: readonly number[]
  branchOutColors: readonly number[]
  continueColors: readonly number[]
  colorIndex: number
  laneShiftFrom: number | null
  owners: readonly SessionId[]
  badges: readonly SessionGraphBadge[]
  placeholder: SessionGraphPlaceholder | undefined
  selected: boolean
  onActivePath: boolean
  branchHeads: Record<string, string> | undefined
  hasChildren: boolean
  expanded: boolean
  selectorMode: boolean
  pending: boolean
  showFork: boolean
  showFocus: boolean
  branchCollapsed: ReadonlySet<string>
  onToggleNode: (key: string) => void
  onToggleBranch: (key: string) => void
  onSelect: (rowKey: string, node: TreeNode) => void
  onFork: (node: TreeNode) => void
  onFocus: (rowKey: string) => void
  onForkUserPrompt: (node: TreeNode) => void
  t: (key: SessionTreeKey) => string
}) {
  const heads = Object.entries(branchHeads ?? {})
    .filter(([, id]) => id === node.nodeId)
    .map(([name]) => name)
  const failed = nodeHasError(node) || placeholder === 'error'
  const kindClass = failed
    ? css.nodeError
    : isToolNode(node)
      ? css.nodeTool
      : placeholder !== undefined
        ? css.nodePlaceholder
        : undefined
  const classes = [
    css.node,
    selected ? css.nodeSelected : undefined,
    kindClass,
  ].filter(Boolean).join(' ')
  const role = node.message === undefined
    ? toolNameOf(node) ?? t('node.noMessage')
    : t(ROLE_LABELS[node.message.role])
  const rawText = nodeFullText(node)
  // An image-only prompt has no text but is still a real node; show a marker
  // instead of rendering an empty row.
  const fullText = rawText.trim() !== ''
    ? rawText
    : (node.message?.role === 'user' ? t('node.image') : rawText)
  const toggleLabel = expanded ? t('node.collapse') : t('node.expand')
  const primaryOwner = owners.at(-1) ?? owners[0]

  return (
    <div
      className={classes}
      data-node-id={node.nodeId}
      data-session-tree-row={rowKey}
      style={edgeSpace === undefined ? undefined : { minHeight: edgeSpace }}
      data-session-owners={owners.join(' ')}
      data-session-owner={primaryOwner}
      data-placeholder={placeholder}
    >
      {hasChildren ? (
        <button
          type="button"
          className={css.expander}
          aria-expanded={expanded}
          aria-label={`${toggleLabel} — ${node.summary}`}
          title={toggleLabel}
          onClick={() => { onToggleNode(rowKey) }}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : (
        <span className={css.expanderPlaceholder} aria-hidden="true" />
      )}
      <Graph
        row={{ node, lane, parentLane, continues, branchOutLanes, branchOutColors, continueColors, colorIndex, laneShiftFrom }}
        selected={selected}
        onActivePath={onActivePath}
        markerOnly={markerOnly}
      />
      <div className={css.nodeContent}>
        {badges.map(badge => {
          const branchExpanded = !branchCollapsed.has(badge.collapseKey)
          const branchToggleLabel = branchExpanded ? t('branch.tree.collapse') : t('branch.tree.expand')
          const badgeContents = (
            <>
              <span className={badgeClass(badge)}>{badgeText(badge, t)}</span>
              {badge.branchLabel === undefined ? null : <span className={css.branchChip}>{badge.branchLabel}</span>}
              {badge.current ? <span className={css.currentChip}>{t('branch.tree.current')}</span> : null}
              {badge.running ? <span className={css.runningDot} /> : null}
            </>
          )
          return (
            <div className={css.branchBadgeLine} key={`${badge.sessionId}:${badge.collapseKey}`}>
              {badge.hasChildren ? (
                <button
                  type="button"
                  className={css.branchBadgeButton}
                  aria-expanded={branchExpanded}
                  aria-label={`${branchToggleLabel} — ${badge.title}`}
                  title={branchToggleLabel}
                  onClick={() => { onToggleBranch(badge.collapseKey) }}
                >
                  {badgeContents}
                </button>
              ) : (
                <span className={css.branchBadgeStatic}>{badgeContents}</span>
              )}
            </div>
          )
        })}
        <button
          type="button"
          className={css.select}
          disabled={pending || (placeholder !== undefined && placeholder !== 'fork')}
          aria-pressed={selectorMode ? undefined : selected}
          aria-label={`${selectorMode ? t('fork.selector.select') : t('panel.select')} — ${node.summary}`}
          title={`${selectorMode ? t('fork.selector.select') : t('panel.select')} — ${node.nodeId}`}
          onClick={() => {
            if (selectorMode) onForkUserPrompt(node)
            else onSelect(rowKey, node)
          }}
        >
          {placeholder === undefined ? (
            <span className={css.nodeTopline}>
              <span className={css.role}>{role}</span>
              {badges.some(badge => badge.branchLabel === node.branch) ? null : (
                <span className={css.branch}>{node.branch}</span>
              )}
              {heads.length > 0 ? <span className={css.head}>{heads.join(', ')}</span> : null}
            </span>
          ) : null}
          <span className={css.summary}>
            {placeholder === undefined ? fullText : <PlaceholderText kind={placeholder} t={t} />}
          </span>
        </button>
      </div>
      <div className={css.rowActions}>
        {showFocus ? (
          <button
            type="button"
            className={css.focusAction}
            disabled={pending || selectorMode}
            title={t('panel.focus')}
            aria-label={`${t('panel.focus')} — ${node.nodeId}`}
            onClick={() => { onFocus(rowKey) }}
          >
            <FocusIcon />
          </button>
        ) : null}
        {showFork ? (
          <button
            type="button"
            className={css.forkAction}
            disabled={pending || selectorMode}
            title={t('panel.fork')}
            aria-label={`${t('panel.fork')} — ${node.nodeId}`}
            onClick={() => { onFork(node) }}
          >
            <BranchIcon />
          </button>
        ) : null}
        {showFocus || showFork ? null : <span className={css.forkActionPlaceholder} aria-hidden="true" />}
      </div>
    </div>
  )
}

function PanelHeader({
  title,
  branchCount,
  nodeCount,
  version,
  pending,
  onRefresh,
  onClose,
  t,
}: {
  title: string
  branchCount: number
  nodeCount: number
  version?: string
  pending: boolean
  onRefresh: () => void
  onClose?: () => void
  t: (key: SessionTreeKey) => string
}) {
  return (
    <header className={css.header}>
      <div className={css.heading}>
        <span className={css.title}>{title}</span>
        <span className={css.stats}>{branchCount} {t('panel.branch')} · {nodeCount} {t('panel.nodes')}</span>
      </div>
      <div className={css.headerActions}>
        <button type="button" className={css.refresh} disabled={pending} onClick={onRefresh}>
          {t('panel.refresh')}
        </button>
        {onClose === undefined ? null : (
          <button type="button" className={css.close} aria-label={t('panel.close')} onClick={onClose}>×</button>
        )}
      </div>
    </header>
  )
}

type MergedSessionTreePanelProps = SessionTreeViewProps & PropsLocale<'session-tree'> & {
  readonly useSessions: NonNullable<SessionTreeViewProps['useSessions']>
  readonly openSession: NonNullable<SessionTreeViewProps['openSession']>
  readonly jumpSession: NonNullable<SessionTreeViewProps['jumpSession']>
}

function MergedSessionTreePanel({
  closeDetails = () => {},
  sessionId,
  load,
  jump,
  jumpSession,
  prepareNode,
  navigateNode,
  activateTurn,
  select,
  fork,
  forkUserPrompt,
  onRefresh,
  useSessions,
  openSession,
  onForkCompleted,
  lineage,
  isArchived,
  archivedSource,
  forkInSession,
  t,
}: MergedSessionTreePanelProps) {
  const listState = useSessions(state => state)
  const storedEntries = useSyncExternalStore(
    lineage?.subscribe ?? NOOP_SUBSCRIBE,
    lineage?.getSnapshot ?? EMPTY_LINEAGE_SNAPSHOT,
    lineage?.getSnapshot ?? EMPTY_LINEAGE_SNAPSHOT,
  )
  // localStorage is origin-scoped; a fresh profile or a changed web port
  // starts with an empty lineage. Rebuild /fork annotations from the native
  // child-id shape so existing forks never render as clones.
  const entries = useMemo(() => {
    const byId = listState.byId ?? {}
    const merged = new Map<SessionId, ForkLineageEntry>(storedEntries)
    for (const id of listState.ids ?? Object.keys(byId) as SessionId[]) {
      if (merged.has(id)) continue
      const match = /^(.*)-fork-[a-z0-9]+-[a-z0-9]{6}$/u.exec(id)
      const parentId = match?.[1] as SessionId | undefined
      if (parentId === undefined || byId[parentId] === undefined) continue
      merged.set(id, {
        childId: id,
        parentId,
        createdAt: byId[id]?.updatedAt ?? 0,
      })
    }
    return merged
  }, [storedEntries, listState])
  // Bind store methods through closures: they read `this`.
  const archiveSubscribe = useMemo(
    () => archivedSource === undefined ? undefined : (listener: () => void) => archivedSource.subscribe(listener),
    [archivedSource],
  )
  const archiveRead = useMemo(
    () => archivedSource === undefined ? undefined : () => archivedSource.getSnapshot(),
    [archivedSource],
  )
  const archivedIds = useSyncExternalStore(
    archiveSubscribe ?? NOOP_SUBSCRIBE,
    archiveRead ?? (() => EMPTY_ARCHIVES),
    archiveRead ?? (() => EMPTY_ARCHIVES),
  )
  const archivedSet = useMemo(() => new Set(archivedIds), [archivedIds])
  const [views, setViews] = useState<ReadonlyMap<SessionId, SessionTreeView>>(() => new Map())
  const [failed, setFailed] = useState<ReadonlySet<SessionId>>(() => new Set())
  const [nodeCollapsed, setNodeCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [branchCollapsed, setBranchCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generations = useRef(new Map<SessionId, number>())
  useEffect(() => () => { generations.current.clear() }, [])
  const viewsRef = useRef(views)
  const failedRef = useRef(failed)
  useEffect(() => { viewsRef.current = views }, [views])
  useEffect(() => { failedRef.current = failed }, [failed])
  const navStatus = useSyncExternalStore(subscribeNavigationStatus, navigationStatus, navigationStatus)
  const remembered = useSyncExternalStore(subscribeSelection, rememberedSelection, rememberedSelection)

  const activeSessionId = currentSessionId(listState)
  const topology = useMemo(
    () => buildBranchTreeModel(sessionId, { ...listState, current: activeSessionId }, entries, archivedSet),
    [sessionId, listState, activeSessionId, entries, archivedSet],
  )
  const projectedViews = useMemo(() => {
    const projected = new Map([...views].map(([id, view]) => [id, projectVisibleView(view)]))
    // The confirmed click is shared across panel instances. Overlay it on the
    // loaded view so a remount never falls back to the previous remote cursor.
    for (const [id, nodeId] of remembered) {
      const view = projected.get(id)
      if (view === undefined || !view.nodes.some(node => node.nodeId === nodeId)) continue
      projected.set(id, { ...view, cursor: nodeId, selectedNodeId: nodeId })
    }
    return projected
  }, [views, remembered])
  const model = useMemo(
    () => topology === null ? null : buildSessionGraphModel(topology, projectedViews, failed),
    [topology, projectedViews, failed],
  )

  // Focus one fork point and show only its subtree (the node plus every
  // descendant branch). Switching Sessions or losing the row clears focus.
  const focusKey = useSyncExternalStore(subscribeFocusKey, focusKeySnapshot, focusKeySnapshot)
  const previousSessionRef = useRef(sessionId)
  const restoredFocusRef = useRef(false)
  useEffect(() => {
    // The panel mounts with placeholder rows and fills views afterwards; only
    // validate once real rows exist, otherwise a remembered focus is dropped
    // before its node has had a chance to load.
    if (focusKey === null || model === null || model.rows.length === 0) return
    if (model.rows.every(row => row.placeholder !== undefined)) return
    if (!model.rows.some(row => row.key === focusKey)) setFocusKey(null)
  }, [focusKey, model])
  useEffect(() => {
    if (focusKey === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFocusKey(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [focusKey])
  const displayModel = useMemo(
    () => model === null ? null : focusKey === null ? model : focusSessionGraph(model, focusKey),
    [model, focusKey],
  )
  const focusRow = focusKey === null ? undefined : model?.rows.find(row => row.key === focusKey)
  // A remembered focus is restored after the sidebar remounts. Only keep it
  // when the Session that reopened the panel still belongs to that subtree;
  // otherwise the viewer switched away and should see the whole tree.
  useEffect(() => {
    if (restoredFocusRef.current || model === null || displayModel === null) return
    if (displayModel.rows.length === 0 || displayModel.rows.every(row => row.placeholder !== undefined)) return
    restoredFocusRef.current = true
    if (focusKey !== null && !displayModel.sessionIds.includes(sessionId)) setFocusKey(null)
  }, [model, displayModel, focusKey, sessionId])
  // Navigating inside the focused subtree (e.g. clicking a node owned by a
  // child Session) must keep the view as-is. Only a switch to a Session that
  // is outside the focused subtree exits focus mode.
  useEffect(() => {
    const previous = previousSessionRef.current
    previousSessionRef.current = sessionId
    if (focusKey === null || previous === sessionId) return
    if (displayModel !== null && !displayModel.sessionIds.includes(sessionId)) setFocusKey(null)
  }, [sessionId, focusKey, displayModel])
  // Filtering replaces the row set while the old scroll offset survives. The
  // focused node is the new first row, so reset the scroller to the top; this
  // also brings it back into view when it was above the previous viewport.
  useLayoutEffect(() => {
    if (focusKey === null) return
    const container = laneContainer.current
    if (container !== null) container.scrollTop = 0
  }, [focusKey])

  // Publish each fork's first own prompt for the left branch menu. The panel
  // is the view holder; the menu only has the Session list.
  useEffect(() => {
    if (topology === null) return
    for (const row of topology.rows) {
      if (row.parentId === undefined) continue
      const child = views.get(row.sessionId)
      const parent = views.get(row.parentId)
      if (child === undefined || parent === undefined) continue
      const first = firstUnsharedUserNode(child, parent)
      if (first === undefined) continue
      const text = nodeFullText(first) || first.summary
      rememberBranchTopic(row.sessionId, text, listState.byId?.[row.sessionId]?.displayTitle)
    }
  }, [views, topology, listState])

  const reload = useCallback(async (ids: readonly SessionId[]): Promise<void> => {
    if (ids.length === 0) return
    const tokens = new Map(ids.map(id => {
      const token = (generations.current.get(id) ?? 0) + 1
      generations.current.set(id, token)
      return [id, token] as const
    }))
    const settled = await Promise.allSettled(ids.map(id => load(id)))
    const currentIds = ids.filter(id => generations.current.get(id) === tokens.get(id))
    if (currentIds.length === 0) return

    const nextViews = new Map<SessionId, SessionTreeView>()
    const nextFailed = new Set<SessionId>()
    settled.forEach((result, index) => {
      const id = ids[index]
      if (id === undefined || generations.current.get(id) !== tokens.get(id)) return
      if (result.status === 'fulfilled') nextViews.set(id, result.value)
      else nextFailed.add(id)
    })
    setViews(current => {
      const next = new Map(current)
      for (const [id, view] of nextViews) next.set(id, view)
      for (const [id, nodeId] of rememberedSelection()) {
        const view = next.get(id)
        if (view === undefined || !view.nodes.some(node => node.nodeId === nodeId)) continue
        next.set(id, { ...view, cursor: nodeId, selectedNodeId: nodeId })
      }
      return next
    })
    setFailed(current => {
      const next = new Set(current)
      for (const id of currentIds) next.delete(id)
      for (const id of nextFailed) next.add(id)
      return next
    })
  }, [load])

  const topologyKey = topology?.rows.map(row => row.sessionId).join('\u0000') ?? ''
  const completedRevision = JSON.stringify(topology?.rows.map(row => {
    const summary = listState.byId?.[row.sessionId] as { updatedAt?: number; running?: boolean } | undefined
    return [row.sessionId, summary?.running === true ? null : summary?.updatedAt ?? 0]
  }) ?? [])
  const observedRevisions = useRef(new Map<SessionId, number | null>())
  useEffect(() => {
    const revisions = JSON.parse(completedRevision) as Array<[SessionId, number | null]>
    const changed: SessionId[] = []
    for (const [id, revision] of revisions) {
      if (revision === null) continue
      const previous = observedRevisions.current.get(id)
      if (previous !== undefined && previous !== revision && viewsRef.current.has(id)) changed.push(id)
    }
    if (changed.length === 0) {
      for (const [id, revision] of revisions) observedRevisions.current.set(id, revision)
      return
    }
    const timer = window.setTimeout(() => {
      for (const [id, revision] of revisions) observedRevisions.current.set(id, revision)
      void reload(changed)
    }, FAN_OUT_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [completedRevision, reload])

  // Only topology changes invalidate initial loads; streaming list updates
  // must not repeatedly cancel them. Completed branches refresh separately.
  useEffect(() => {
    if (topology === null) return
    // Only load Sessions this panel has never seen: a cursor/Session switch must
    // not re-fetch every (possibly huge) tree and stall the click.
    const missing = topology.rows
      .map(row => row.sessionId)
      .filter(id => !viewsRef.current.has(id) && !failedRef.current.has(id))
    if (missing.length === 0) return
    const timer = window.setTimeout(() => { void reload(missing) }, FAN_OUT_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [topologyKey, reload])

  useEffect(() => onRefresh?.(() => {
    if (topology === null) return
    void reload(topology.rows.map(row => row.sessionId))
  }), [onRefresh, reload, topology])

  // A newly arrived Session/branch starts expanded. Collapse state is a view
  // preference, so it is safe to reset when the graph gains new topology.
  const previousSessionKey = useRef<string | null>(null)
  useEffect(() => {
    if (model === null) return
    const nextKey = model.sessionIds.join('\u0000')
    const previous = previousSessionKey.current
    previousSessionKey.current = nextKey
    if (previous === null || previous === nextKey) return
    const previousIds = new Set(previous === '' ? [] : previous.split('\u0000'))
    if (!model.sessionIds.some(id => !previousIds.has(id))) return
    setNodeCollapsed(new Set())
    setBranchCollapsed(new Set())
  }, [model])

  const previousLineageSize = useRef(entries.size)
  useEffect(() => {
    const previous = previousLineageSize.current
    previousLineageSize.current = entries.size
    if (entries.size <= previous) return
    setNodeCollapsed(new Set())
    setBranchCollapsed(new Set())
  }, [entries])

  // Switching the open Session reveals its ancestor branches without user
  // action, so the new active path is always visible.
  const previousHighlighted = useRef<SessionId | undefined>(undefined)
  useEffect(() => {
    if (model === null) return
    const previous = previousHighlighted.current
    previousHighlighted.current = model.highlightedId
    if (previous === undefined || previous === model.highlightedId) return
    setBranchCollapsed(current => {
      const next = new Set(current)
      let changed = false
      for (const key of model.activeBranchKeys) {
        if (next.delete(key)) changed = true
      }
      return changed ? next : current
    })
    setNodeCollapsed(current => {
      const next = new Set(current)
      let changed = false
      for (const key of model.activePathKeys) {
        if (next.delete(key)) changed = true
      }
      return changed ? next : current
    })
  }, [model])

  const toggleNode = useCallback((key: string): void => {
    setNodeCollapsed(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  const toggleBranch = useCallback((key: string): void => {
    setBranchCollapsed(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // Every branch keeps its own fork point: the latest typed prompt of THAT
  // session, so a message sent in a child never disables forking the main line.
  const latestPromptBySession = useMemo(() => {
    const latest = new Map<SessionId, string>()
    for (const [sessionId, view] of views) {
      const prompts = view.nodes.filter(isUserPromptNode)
      const node = prompts.at(-1)
      if (node !== undefined) latest.set(sessionId, node.nodeId)
    }
    return latest
  }, [views])

  const forkTargetOf = useCallback((row: SessionGraphRow): { sessionId: SessionId; nodeId: string } | undefined => {
    for (const owner of row.owners) {
      const localId = row.ownerNodeIds.get(owner)
      if (localId !== undefined && latestPromptBySession.get(owner) === localId) {
        return { sessionId: owner, nodeId: localId }
      }
    }
    return undefined
  }, [latestPromptBySession])

  const laneContainer = useRef<HTMLDivElement>(null)
  const visibleRows = useMemo(() => {
    if (displayModel === null) return []
    const rowByKey = new Map(displayModel.rows.map(row => [row.key, row]))
    const hiddenByNodeCollapse = (row: SessionGraphRow): boolean => {
      const seen = new Set<string>()
      let parentKey = row.parentKey
      while (parentKey !== null && !seen.has(parentKey)) {
        if (nodeCollapsed.has(parentKey)) return true
        seen.add(parentKey)
        parentKey = rowByKey.get(parentKey)?.parentKey ?? null
      }
      return false
    }
    return displayModel.rows.filter(row => {
      if (hiddenByNodeCollapse(row)) return false
      for (const collapseKey of branchCollapsed) {
        const keepsBranchAnchorVisible = row.badges.some(badge => badge.collapseKey === collapseKey)
        if (!keepsBranchAnchorVisible && row.branchKeys.includes(collapseKey)) return false
      }
      return true
    })
  }, [branchCollapsed, displayModel, nodeCollapsed])

  const reloadCurrent = useCallback((): void => {
    if (model === null) return
    void reload(model.sessionIds)
  }, [model, reload])

  useEffect(() => attachRailScrollSync(), [])

  const handleSelect = useCallback((rowKey: string, node: TreeNode): void => {
    if (pending || model === null) return
    const row = model.rows.find(candidate => candidate.key === rowKey)
    if (row?.placeholder === 'fork') {
      const owner = row.owners[0]
      if (owner !== undefined && !isArchived?.(owner)) openSession(owner)
      return
    }
    if (node.nodeId.startsWith('__session-tree-') || row === undefined || row.placeholder !== undefined) return
    // A forked/shared node belongs to the main line first: clicking it always
    // returns to the root Session. Only nodes unique to a fork open that fork.
    const rootId = topology?.rootId
    const targetSessionId = rootId !== undefined && row.owners.includes(rootId)
      ? rootId
      : row.owners.includes(model.highlightedId)
        ? model.highlightedId
        : row.owners[0]
    if (targetSessionId === undefined || isArchived?.(targetSessionId)) return
    const targetNodeId = row.ownerNodeIds.get(targetSessionId) ?? node.nodeId
    const targetView = views.get(targetSessionId)
    // Renumbered forks reuse node ids for copied prefix nodes, so the id alone
    // can resolve to the parent message. Prefer the node whose text matches.
    const nodeText = nodeFullText(node)
    const localNode = targetView?.nodes.find(candidate => candidate.nodeId === targetNodeId && nodeFullText(candidate) === nodeText)
      ?? targetView?.nodes.find(candidate => candidate.nodeId === targetNodeId)
      ?? node
    const switchSession = targetSessionId !== model.highlightedId
    void requestNodeNavigation({
      sessionId: targetSessionId,
      nodeId: targetNodeId,
      node: localNode,
      switchSession,
      ...(nodeFullText(localNode).trim() === '' ? {} : { expectText: nodeFullText(localNode) }),
    }, {
      openSession,
      ...(prepareNode === undefined ? {} : { prepare: prepareNode }),
      navigate: (sessionId, target, signal, options) => navigateNode === undefined
        ? Promise.resolve().then(() => { scrollConversationToNode(target) })
        : navigateNode(sessionId, target, signal, options),
      persist: async nodeId => { await (switchSession ? jumpSession(targetSessionId, nodeId) : jump(nodeId)) },
    })
  }, [isArchived, jump, jumpSession, model, navigateNode, openSession, pending, prepareNode, views])

  const handleFork = useCallback(async (row: SessionGraphRow): Promise<void> => {
    if (pending) return
    const target = forkTargetOf(row)
    if (target === undefined) return
    setPending(true)
    setError(null)
    try {
      const branch = `fork-${Date.now().toString(36)}`
      const result: SessionTreeForkView = target.sessionId === model?.highlightedId || forkInSession === undefined
        ? await fork(target.nodeId, branch)
        : await forkInSession(target.sessionId, target.nodeId, branch)
      onForkCompleted?.(result)
      reloadCurrent()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }, [fork, forkInSession, forkTargetOf, model, onForkCompleted, pending, reloadCurrent])

  const handleForkUserPrompt = useCallback(async (node: TreeNode): Promise<void> => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      if (forkUserPrompt === undefined) throw new Error('native fork action is unavailable')
      await forkUserPrompt(node)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }, [forkUserPrompt, pending])

  if (displayModel === null) return null
  const gutter = 14 + Math.max(0, ...displayModel.rows.map(row => row.lane)) * 15 + 18
  const focusText = focusRow === undefined
    ? ''
    : (nodeFullText(focusRow.node).trim() || focusRow.node.summary).slice(0, 48)

  return (
    <section data-session-tree-panel className={css.panel} aria-label={t('panel.title')} data-nav-pending={navStatus.pending} data-nav-request={navStatus.requestId} data-nav-error={navStatus.error ?? ''}>
      <PanelHeader
        title={t('panel.title')}
        branchCount={displayModel.sessionIds.length}
        nodeCount={displayModel.rows.length}
        version={SESSION_TREE_VERSION}
        pending={pending}
        onRefresh={reloadCurrent}
        onClose={closeDetails}
        t={t}
      />
      {focusRow === undefined ? null : (
        <div className={css.focusBar}>
          <button type="button" className={css.focusAll} onClick={() => { setFocusKey(null) }}>
            {t('panel.focusAll')}
          </button>
          <span aria-hidden="true">/</span>
          <span className={css.focusCrumb} title={focusText}>{focusText}</span>
          <button
            type="button"
            className={css.focusExit}
            aria-label={t('panel.focusExit')}
            onClick={() => { setFocusKey(null) }}
          >
            ×
          </button>
        </div>
      )}
      <div className={css.legend}><span className={css.legendDot} />{t('panel.selectedHint')}</div>
      <div
        ref={laneContainer}
        className={css.body}
        style={{ ['--lane-gutter' as string]: `${gutter}px` }}
        aria-busy={displayModel.rows.some(row => row.placeholder === 'loading') || pending || navStatus.pending}
      >
        {error === null && navStatus.error === null ? null : <p className={css.error}>{t('panel.error')}: {error ?? navStatus.error}</p>}
        {displayModel.rows.length === 0 ? <p className={css.empty}>{t('panel.empty')}</p> : null}
        <LaneEdges container={laneContainer} rows={visibleRows} allRows={displayModel.rows} colors={LANE_COLORS} />
        {visibleRows.map(row => (
          <NodeRow
            key={row.key}
            rowKey={row.key}
            markerOnly
            edgeSpace={row.branchOutLanes.length === 0 ? undefined : Math.max(80, ...row.branchOutLanes.map(lane => Math.abs(laneX(lane) - laneX(row.lane)) * 2 + 32))}
            node={row.node}
            lane={row.lane}
            parentLane={row.parentLane}
            continues={row.continues}
            branchOutLanes={row.branchOutLanes}
            branchOutColors={row.branchOutColors}
            continueColors={row.continueColors}
            colorIndex={row.colorIndex}
            laneShiftFrom={row.laneShiftFrom}
            owners={row.owners}
            badges={row.badges}
            placeholder={row.placeholder}
            selected={row.active}
            onActivePath={row.onActivePath}
            branchHeads={views.get(row.owners.at(-1) ?? displayModel.highlightedId)?.branchHeads}
            hasChildren={row.hasChildren}
            expanded={!nodeCollapsed.has(row.key)}
            selectorMode={false}
            pending={pending}
            showFork={row.placeholder === undefined && forkTargetOf(row) !== undefined}
            // Focus belongs to the branch-start row (the row carrying a fork or
            // clone badge), not the shared fork anchor. Focusing the anchor kept
            // the trunk continuation, so a fork point on the main line appeared
            // unfiltered; the branch row isolates exactly that branch subtree.
            showFocus={focusKey === null && row.placeholder === undefined
              && row.badges.some(badge => badge.kind !== 'main')}
            branchCollapsed={branchCollapsed}
            onToggleNode={toggleNode}
            onToggleBranch={toggleBranch}
            onSelect={handleSelect}
            onFork={() => { void handleFork(row) }}
            onFocus={setFocusKey}
            onForkUserPrompt={node => { void handleForkUserPrompt(node) }}
            t={t}
          />
        ))}
      </div>
    </section>
  )
}

function LegacySessionTreePanel({
  closeDetails = () => {},
  sessionId,
  load,
  jump,
  select,
  fork,
  forkUserPrompt,
  onRefresh,
  useSessions,
  onForkCompleted,
  selectorMode,
  t,
}: SessionTreeViewProps & PropsLocale<'session-tree'> & { selectorMode: boolean }) {
  const [view, setView] = useState<SessionTreeView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())

  const refresh = useCallback(async () => {
    setError(null)
    try {
      setView(await load(sessionId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [load, sessionId])

  const sessionListRevision = useSessions?.(state => {
    const ids = Array.isArray(state.ids) ? state.ids : []
    const byId = state.byId ?? {}
    return [
      state.phase ?? '',
      currentSessionId(state) ?? '',
      ids.join('\n'),
      ids.map(id => {
        const row = byId[id]
        return row === undefined ? '' : [row.displayTitle, row.blank, row.running, row.updatedAt].join(':')
      }).join('\n'),
    ].join('|')
  })

  useEffect(() => {
    if (sessionListRevision !== undefined) return
    void refresh()
  }, [refresh, sessionListRevision])
  useEffect(() => onRefresh?.(() => { void refresh() }), [onRefresh, refresh])
  useEffect(() => {
    if (sessionListRevision === undefined) return
    void refresh()
  }, [refresh, sessionListRevision])

  const visibleNodes = useMemo(() => projectVisibleNodes(view?.nodes ?? []), [view?.nodes])
  const displayedNodes = useMemo(() => {
    if (!selectorMode) return visibleNodes
    // Only the latest prompt is forkable; render it as the lone root.
    const latest = projectVisibleNodes(visibleNodes, isUserPromptNode).at(-1)
    return latest === undefined ? [] : [{ ...latest, parentId: null }]
  }, [selectorMode, visibleNodes])
  const forkableNodeId = displayedNodes.at(-1)?.nodeId ?? null
  const rows = useMemo(() => graphRows(displayedNodes), [displayedNodes])
  const childIds = useMemo(() => {
    const children = new Map<string, string[]>()
    for (const node of displayedNodes) {
      const parentId = node.parentId
      if (parentId === null) continue
      const siblings = children.get(parentId)
      if (siblings === undefined) children.set(parentId, [node.nodeId])
      else siblings.push(node.nodeId)
    }
    return children
  }, [displayedNodes])

  const visibleRows = useMemo(() => {
    if (selectorMode) return rows
    const byId = new Map(displayedNodes.map(node => [node.nodeId, node]))
    const hidden = (node: TreeNode): boolean => {
      const seen = new Set<string>()
      let parentId = node.parentId
      while (parentId !== null && !seen.has(parentId)) {
        if (collapsed.has(parentId)) return true
        seen.add(parentId)
        parentId = byId.get(parentId)?.parentId ?? null
      }
      return false
    }
    return rows.filter(row => !hidden(row.node))
  }, [collapsed, displayedNodes, rows, selectorMode])

  const panelTitle = selectorMode ? t('fork.selector.title') : t('panel.title')
  const legacyGutter = 14 + Math.max(0, ...rows.map(row => row.lane)) * 15 + 18
  const handleSelect = useCallback(async (rowKey: string, node: TreeNode) => {
    if (selectorMode) {
      if (pending) return
      setPending(true)
      setError(null)
      try {
        if (forkUserPrompt === undefined) throw new Error('native fork action is unavailable')
        await forkUserPrompt(node)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setPending(false)
      }
      return
    }
    if (pending) return
    setError(null)
    // Paint the selection before the remote round-trip: the row and current
    // cursor update instantly, the Host catches up in the background.
    setView(current => current === null ? current : { ...current, cursor: node.nodeId, selectedNodeId: node.nodeId })
    if (select !== undefined) void select(node.nodeId).catch(() => {})
    scrollConversationToNode(node)
    void jump(node.nodeId).catch(cause => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [forkUserPrompt, jump, pending, select, selectorMode])

  const handleFork = useCallback(async (node: TreeNode) => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const result: SessionTreeForkView = await fork(node.nodeId, `fork-${Date.now().toString(36)}`)
      onForkCompleted?.(result)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }, [fork, onForkCompleted, pending, refresh])

  const toggleNode = useCallback((nodeId: string) => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }, [])

  return (
    <section className={css.panel} aria-label={panelTitle}>
      <PanelHeader
        title={panelTitle}
        branchCount={view?.branches.length ?? 0}
        nodeCount={displayedNodes.length}
        pending={pending}
        onRefresh={() => { void refresh() }}
        onClose={closeDetails}
        t={t}
      />
      <div className={css.legend}><span className={css.legendDot} />{t('panel.selectedHint')}</div>
      <div
        className={css.body}
        style={{ ['--lane-gutter' as string]: `${legacyGutter}px` }}
        aria-busy={pending}
      >
        {error === null ? null : <p className={css.error}>{t('panel.error')}: {error}</p>}
        {view !== null && (selectorMode ? displayedNodes.length === 0 : rows.length === 0)
          ? <p className={css.empty}>{selectorMode ? t('fork.selector.empty') : t('panel.empty')}</p>
          : null}
        {visibleRows.map(row => (
          <NodeRow
            key={row.node.nodeId}
            rowKey={row.node.nodeId}
            node={row.node}
            lane={row.lane}
            parentLane={row.parentLane}
            continues={row.continues}
            branchOutLanes={[]}
            branchOutColors={[]}
            continueColors={[]}
            colorIndex={row.lane}
            laneShiftFrom={null}
            owners={[]}
            badges={[]}
            placeholder={undefined}
            selected={row.node.nodeId === view?.selectedNodeId}
            onActivePath={false}
            branchHeads={view?.branchHeads}
            hasChildren={(childIds.get(row.node.nodeId)?.length ?? 0) > 1}
            expanded={!collapsed.has(row.node.nodeId)}
            selectorMode={selectorMode}
            pending={pending}
            showFork={!selectorMode && row.node.nodeId === forkableNodeId}
            showFocus={false}
            onFocus={() => {}}
            branchCollapsed={EMPTY_COLLAPSED}
            onToggleNode={toggleNode}
            onToggleBranch={() => {}}
            onSelect={handleSelect}
            onFork={node => { void handleFork(node) }}
            onForkUserPrompt={node => { void handleSelect(row.node.nodeId, node) }}
            t={t}
          />
        ))}
      </div>
    </section>
  )
}

export function SessionTreePanel(props: SessionTreeViewProps & PropsLocale<'session-tree'>) {
  const modeSnapshot = useSyncExternalStore(
    props.modeController?.subscribe ?? NOOP_SUBSCRIBE,
    props.modeController?.getSnapshot ?? NOOP_GET_MODE_SNAPSHOT,
    props.modeController?.getSnapshot ?? NOOP_GET_MODE_SNAPSHOT,
  )
  const selectorMode = props.mode === 'selectUserPrompt' || modeSnapshot.selectorOpen
  const { useSessions, openSession, jumpSession } = props
  if (!selectorMode && useSessions !== undefined && openSession !== undefined && jumpSession !== undefined) {
    return (
      <MergedSessionTreePanel
        {...props}
        useSessions={useSessions}
        openSession={openSession}
        jumpSession={jumpSession}
      />
    )
  }
  return <LegacySessionTreePanel {...props} selectorMode={selectorMode} />
}

export function SessionTreeDock(props: SessionTreeViewProps & PropsLocale<'session-tree'>) {
  return <SessionTreePanel {...props} />
}
