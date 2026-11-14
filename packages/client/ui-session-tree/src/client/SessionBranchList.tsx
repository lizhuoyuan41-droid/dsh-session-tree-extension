/**
 * Inline /fork branch menus for the native session list.
 *
 * The native list owns the source Session row. This component portals one
 * collapsible menu directly after that row, hides the native rows for its
 * /fork descendants, and keeps /clone rows untouched. Topology and liveness
 * come from the official reactive Session list; the lineage registry only
 * distinguishes /fork children from /clone children and supplies the short
 * title annotation.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionTreeKey } from './locales.ts'
import type { ForkLineageEntry, SessionForkLineage } from './fork-lineage.ts'
import css from './SessionBranchList.module.css'
import { currentSessionId } from './session-list.ts'
import { branchTopics, subscribeBranchTopics, type BranchTopic } from './branch-topic.ts'
import { branchMenusSnapshot, subscribeBranchMenus, toggleBranchMenu, branchMenuDuration } from './branch-menu-state.ts'
import { holdScrollAnchorDuring } from './scroll-anchor.ts'

type OpenSessionMenu = (sessionId: SessionId, displayTitle: string, point: { x: number; y: number }) => void
interface ArchiveState { readonly archivedSessionIds: readonly SessionId[] }
interface ArchiveSource {
  subscribe(listener: () => void): () => void
  getSnapshot(): ArchiveState
}
const EMPTY_ARCHIVES: ArchiveState = { archivedSessionIds: [] }
const EMPTY_STATUSES: SessionStatusSnapshot = new Map()
const noArchiveSubscribe = () => () => {}
const noArchiveSnapshot = () => EMPTY_ARCHIVES

const BRANCH_HOST = '[data-session-tree-branch-host]'
const HIDDEN_ATTRIBUTE = 'data-session-tree-branch-hidden'
const PREVIOUS_DISPLAY_ATTRIBUTE = 'data-session-tree-branch-previous-display'

/** One rendered /fork descendant inside an inline branch menu. */
interface BranchRow {
  readonly sessionId: SessionId
  readonly entry: ForkLineageEntry
  readonly depth: number
  readonly isLast: boolean
  readonly railContinues: readonly boolean[]
  readonly childCount: number
  readonly title: string
  readonly displayTitle: string
  readonly running: boolean
  /** The Host reports an unacknowledged background stop (native green dot). */
  readonly completed: boolean
  readonly current: boolean
}

/** One native parent row and the /fork descendants rendered beneath it. */
interface BranchGroup {
  readonly sourceId: SessionId
  readonly sourceTitle: string
  readonly rows: readonly BranchRow[]
}

interface BranchBuild {
  readonly groups: readonly BranchGroup[]
  readonly liveBranches: number
}

interface HiddenRow {
  readonly sessionId: SessionId
  readonly display: string
}

/** Build the inline menus from the live list and /fork annotations. */
/**
 * Branch label priority:
 * 1. the first typed prompt after the fork boundary;
 * 2. the host title once it changed after that capture (dynamic title / rename);
 * 3. inheriting title only while it still equals the parent → “parent · fork N”.
 */
function branchLabel(
  hostTitle: string | undefined,
  parentTitle: string,
  topic: BranchTopic | undefined,
  forkLabel: string,
): string {
  if (topic !== undefined) {
    if (hostTitle !== undefined && hostTitle !== topic.titleAtCapture && hostTitle !== parentTitle) return hostTitle
    return topic.text
  }
  if (hostTitle !== undefined && hostTitle !== parentTitle) return hostTitle
  return `${parentTitle} · ${forkLabel}`
}

function branchGroups(
  state: SessionListState,
  entries: ReadonlyMap<SessionId, ForkLineageEntry>,
  topics: ReadonlyMap<SessionId, BranchTopic>,
  statuses: SessionStatusSnapshot,
  forkLabel: (index: number) => string,
): BranchBuild {
  const byId = state.byId ?? {} as Record<SessionId, SessionSummary>
  const branches = [...entries.values()]
    .filter(entry => Object.prototype.hasOwnProperty.call(byId, entry.childId))
    .sort((a, b) => a.createdAt - b.createdAt)

  const parentOf = (entry: ForkLineageEntry): SessionId =>
    byId[entry.childId]?.parentId ?? entry.parentId

  const childrenByParent = new Map<SessionId, ForkLineageEntry[]>()
  for (const entry of branches) {
    const parentId = parentOf(entry)
    const siblings = childrenByParent.get(parentId)
    if (siblings === undefined) childrenByParent.set(parentId, [entry])
    else siblings.push(entry)
  }

  const branchIds = new Set(branches.map(entry => entry.childId))
  const ids = Array.isArray(state.ids) ? state.ids : Object.keys(byId) as SessionId[]
  const groups: BranchGroup[] = []

  for (const sourceId of ids) {
    if (branchIds.has(sourceId)) continue
    const children = childrenByParent.get(sourceId)
    if (children === undefined || children.length === 0) continue

    const rows: BranchRow[] = []
    const visit = (
      parentId: SessionId,
      depth: number,
      railContinues: readonly boolean[],
      ancestors: ReadonlySet<SessionId>,
    ): void => {
      const siblings = childrenByParent.get(parentId) ?? []
      siblings.forEach((entry, index) => {
        if (ancestors.has(entry.childId)) return
        const isLast = index === siblings.length - 1
        const summary = byId[entry.childId]
        const parentTitle = byId[parentId]?.displayTitle ?? parentId
        rows.push({
          sessionId: entry.childId,
          entry,
          depth,
          isLast,
          railContinues,
          childCount: childrenByParent.get(entry.childId)?.length ?? 0,
          title: branchLabel(summary?.displayTitle, parentTitle, topics.get(entry.childId), forkLabel(index + 1)),
          displayTitle: summary?.displayTitle ?? entry.childId,
          running: summary?.running === true,
          completed: statuses.get(entry.childId)?.completionUnread === true,
          current: currentSessionId(state) === entry.childId,
        })
        const nextAncestors = new Set(ancestors)
        nextAncestors.add(entry.childId)
        visit(entry.childId, depth + 1, [...railContinues, !isLast], nextAncestors)
      })
    }
    visit(sourceId, 1, [], new Set([sourceId]))
    groups.push({
      sourceId,
      sourceTitle: byId[sourceId]?.displayTitle ?? sourceId,
      rows,
    })
  }

  return { groups, liveBranches: branches.length }
}

/** Normalize one native row's text for title matching. */
function normalizedText(value: string | null): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim()
}

/** Score a native row against one Session title. */
function titleScore(rowText: string, displayTitle: string): number {
  const title = normalizedText(displayTitle)
  if (title === '') return 0
  if (rowText === title) return 10_000 + title.length
  if (rowText.startsWith(title)) return 8_000 + title.length
  if (rowText.includes(title)) return 6_000 + title.length
  if (title.includes(rowText) && rowText.length > 1) return 4_000 + rowText.length
  return 0
}

/** Return the native session rows, excluding search-result buttons. */
function nativeSessionRows(): HTMLElement[] {
  if (typeof document === 'undefined') return []
  return [...document.querySelectorAll<HTMLElement>(
    'div[role="tree"] div[role="treeitem"][aria-selected]',
  )].filter(row => row.closest(BRANCH_HOST) === null)
}

/**
 * Match native rows to Session ids. Previous DOM identity wins, followed by
 * the selected row, title scoring, and finally rendered-order pairing.
 */
function matchNativeRows(
  rows: readonly HTMLElement[],
  state: SessionListState,
  previous: WeakMap<HTMLElement, SessionId>,
): Map<HTMLElement, SessionId> {
  const byId = state.byId ?? {} as Record<SessionId, SessionSummary>
  const ids = (Array.isArray(state.ids) ? state.ids : Object.keys(byId) as SessionId[])
    .filter(id => byId[id] !== undefined)
  const remaining = new Set(ids)
  const matched = new Map<HTMLElement, SessionId>()

  for (const row of rows) {
    const id = previous.get(row)
    if (id === undefined || !remaining.has(id)) continue
    matched.set(row, id)
    remaining.delete(id)
  }

  const current = currentSessionId(state)
  if (current !== undefined && remaining.has(current)) {
    const currentRow = rows.find(row =>
      !matched.has(row) && row.getAttribute('aria-selected') === 'true')
    if (currentRow !== undefined) {
      matched.set(currentRow, current)
      remaining.delete(current)
    }
  }

  const candidates: Array<{ row: HTMLElement; id: SessionId; score: number }> = []
  for (const row of rows) {
    if (matched.has(row)) continue
    const rowText = normalizedText(row.textContent)
    for (const id of remaining) {
      const score = titleScore(rowText, byId[id]?.displayTitle ?? id)
      if (score > 0) candidates.push({ row, id, score })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  for (const candidate of candidates) {
    if (matched.has(candidate.row) || !remaining.has(candidate.id)) continue
    matched.set(candidate.row, candidate.id)
    remaining.delete(candidate.id)
  }

  const freeRows = rows.filter(row => !matched.has(row))
  const freeIds = ids.filter(id => remaining.has(id))
  const pairCount = Math.min(freeRows.length, freeIds.length)
  for (let index = 0; index < pairCount; index++) {
    const row = freeRows[index]
    const id = freeIds[index]
    if (row === undefined || id === undefined) continue
    matched.set(row, id)
  }

  for (const [row, id] of matched) previous.set(row, id)
  return matched
}

function sameHosts(
  left: ReadonlyMap<SessionId, HTMLElement>,
  right: ReadonlyMap<SessionId, HTMLElement>,
): boolean {
  if (left.size !== right.size) return false
  for (const [id, host] of left) {
    if (right.get(id) !== host) return false
  }
  return true
}

/** One animated children container shared by every branch depth. */
function BranchChildren({
  parentId,
  expanded,
  children,
}: {
  parentId: SessionId
  expanded: boolean
  children: React.ReactNode
}) {
  const ref = useRef<HTMLUListElement>(null)
  const shellRef = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (ref.current !== null) ref.current.inert = !expanded
  }, [expanded])
  // Scale the collapse/expand duration with the measured content height so a
  // tall subtree does not snap shut in the same fixed time as one row.
  useLayoutEffect(() => {
    const height = ref.current?.scrollHeight ?? 0
    const duration = branchMenuDuration(height)
    shellRef.current?.style.setProperty('--branch-collapse-duration', `${duration}ms`)
  }, [expanded])
  return (
    <li
      ref={shellRef}
      className={css.menuBody}
      data-expanded={expanded}
      aria-hidden={!expanded}
      data-session-tree-branch-body
      data-branch-parent={parentId}
    >
      <ul className={css.menuList} ref={ref}>{children}</ul>
    </li>
  )
}

function BranchRowView({
  row,
  expanded,
  onToggle,
  onOpen,
  openSessionMenu,
  t,
}: {
  row: BranchRow
  expanded: boolean
  onToggle: (sessionId: SessionId) => void
  onOpen: (sessionId: SessionId) => void
  openSessionMenu?: OpenSessionMenu | undefined
  t: (key: SessionTreeKey) => string
}) {
  const classes = [css.row, row.current ? css.rowCurrent : undefined].filter(Boolean).join(' ')
  const toggleLabel = expanded ? t('node.collapse') : t('node.expand')
  return (
    <li
      className={classes}
      data-branch-session-id={row.sessionId}
      data-branch-depth={row.depth}
    >
      {row.railContinues.map((continues, level) => (
        <span
          key={level}
          className={[css.cell, continues ? css.cellRail : undefined].filter(Boolean).join(' ')}
          aria-hidden="true"
        />
      ))}
      <span
        className={[css.cell, css.cellElbow, row.isLast ? css.cellElbowLast : undefined]
          .filter(Boolean)
          .join(' ')}
        aria-hidden="true"
      >
        <span className={css.elbowDot} />
      </span>
      {row.childCount > 0 ? (
        <button
          type="button"
          className={css.expander}
          aria-expanded={expanded}
          aria-label={`${toggleLabel} - ${row.title}`}
          title={toggleLabel}
          onClick={() => { onToggle(row.sessionId) }}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3.8 1.8 9.4 6l-5.6 4.2Z" fill="currentColor" />
          </svg>
        </button>
      ) : (
        <span className={css.expanderPlaceholder} aria-hidden="true" />
      )}
      <button
        type="button"
        className={css.select}
        aria-label={`${t('branch.node.open')} - ${row.title}`}
        aria-current={row.current ? 'true' : undefined}
        title={row.title}
        onClick={() => { onOpen(row.sessionId) }}
      >
        <span className={css.topline}>
          <span className={css.forkBadge}>{t('branch.node.forkBadge')}</span>
          {row.entry.branch === undefined
            ? null
            : <span className={css.branchChip}>{row.entry.branch}</span>}
          {row.running
            ? <span className={css.runningDot} />
            : row.completed
              ? (
                  <span
                    className={css.completedDot}
                    role="img"
                    aria-label={t('branch.node.completed')}
                    title={t('branch.node.completed')}
                    data-branch-completed="true"
                  />
                )
              : null}
        </span>
        <span className={css.summary}>{row.title}</span>
      </button>
      {openSessionMenu === undefined ? null : (
        <button
          type="button"
          className={css.expander}
          aria-label={`${t('branch.node.manage')} - ${row.title}`}
          title={t('branch.node.manage')}
          onClick={event => {
            const rect = event.currentTarget.getBoundingClientRect()
            openSessionMenu(row.sessionId, row.displayTitle, { x: rect.left, y: rect.bottom })
          }}
        >⋯</button>
      )}
    </li>
  )
}

/** Top-level source a (possibly nested) archived fork belongs under. */
export function forkSourceOf(
  entry: ForkLineageEntry,
  entries: ReadonlyMap<SessionId, ForkLineageEntry>,
): SessionId {
  let parentId = entry.parentId
  const seen = new Set<SessionId>()
  while (entries.has(parentId) && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = entries.get(parentId)!
    if (parent.parentId === parentId) break
    parentId = parent.parentId
  }
  return parentId
}

function BranchMenu({
  group,
  expanded,
  collapsed,
  onToggle,
  onToggleRow,
  onOpen,
  openSessionMenu,
  archivedForks,
  allEntries,
  titleOf,
  archivedIds,
  showArchived,
  unarchive,
  t,
}: {
  group: BranchGroup
  expanded: boolean
  collapsed: ReadonlySet<SessionId>
  /** Toggle the whole menu header. */
  onToggle: (sessionId: SessionId) => void
  /** Toggle one nested branch row. */
  onToggleRow: (sessionId: SessionId) => void
  onOpen: (sessionId: SessionId) => void
  openSessionMenu?: OpenSessionMenu | undefined
  archivedForks: readonly ForkLineageEntry[]
  allEntries: ReadonlyMap<SessionId, ForkLineageEntry>
  titleOf: (sessionId: SessionId) => string
  archivedIds: ReadonlySet<SessionId>
  showArchived: boolean
  unarchive?: ((sessionId: SessionId) => void) | undefined
  t: (key: SessionTreeKey) => string
}) {
  const toggleLabel = expanded ? t('branch.menu.collapse') : t('branch.menu.expand')
  const activeRows = group.rows.filter(row => !archivedIds.has(row.sessionId))
  const completedCount = activeRows.filter(row => row.completed).length
  const bodyRef = useRef<HTMLUListElement>(null)
  const shellRef = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (bodyRef.current !== null) bodyRef.current.inert = !expanded
  }, [expanded])
  // Match the transition time to the measured menu height: long subtrees keep a
  // readable travel speed instead of collapsing in the fixed short duration.
  useLayoutEffect(() => {
    const height = bodyRef.current?.scrollHeight ?? 0
    const duration = branchMenuDuration(height)
    shellRef.current?.style.setProperty('--branch-collapse-duration', `${duration}ms`)
  }, [expanded])
  // Only forks split from THIS parent belong under its menu. The archived
  // entry is named after the parent Session (what it was forked from), not
  // after the prompt summary or the child id.
  const groupArchivedForks = archivedForks.filter(entry =>
    forkSourceOf(entry, allEntries) === group.sourceId)
  const restoredCount = groupArchivedForks.length
  const parentNameOf = (entry: ForkLineageEntry): string =>
    titleOf(entry.parentId) || entry.parentId
  /** Keep the native scroller from re-anchoring while one fold runs. */
  const holdForRow = (sessionId: SessionId): void => {
    const nested = shellRef.current?.querySelector<HTMLElement>(
      `[data-session-tree-branch-body][data-branch-parent="${sessionId}"]`,
    )
    const content = nested?.querySelector<HTMLElement>('ul')
    holdScrollAnchorDuring(nested ?? shellRef.current, branchMenuDuration(content?.scrollHeight ?? 0))
  }
  const toggleRow = (sessionId: SessionId): void => {
    holdForRow(sessionId)
    onToggleRow(sessionId)
  }
  // Render every level as a tree so each parent owns an animated children
  // container; collapsing one branch no longer removes its descendants.
  const renderRows = (start: number, depth: number): { nodes: React.ReactNode[]; next: number } => {
    const nodes: React.ReactNode[] = []
    let index = start
    while (index < activeRows.length && activeRows[index]!.depth === depth) {
      const row = activeRows[index]!
      index += 1
      const children: React.ReactNode[] = []
      if (index < activeRows.length && activeRows[index]!.depth > depth) {
        const nested = renderRows(index, depth + 1)
        children.push(...nested.nodes)
        index = nested.next
      }
      nodes.push(
        <BranchRowView
          key={row.sessionId}
          row={row}
          expanded={!collapsed.has(row.sessionId)}
          onToggle={toggleRow}
          onOpen={onOpen}
          openSessionMenu={openSessionMenu}
          t={t}
        />,
      )
      if (children.length > 0) {
        nodes.push(
          <BranchChildren
            key={`children-${row.sessionId}`}
            parentId={row.sessionId}
            expanded={!collapsed.has(row.sessionId)}
          >
            {children}
          </BranchChildren>,
        )
      }
    }
    return { nodes, next: index }
  }
  const tree = renderRows(0, activeRows[0]?.depth ?? 1)
  // No live forks means no header at all — unless the native list is showing
  // archived rows, where the menu must remain as the restore entry.
  if (activeRows.length === 0 && !(showArchived && restoredCount > 0)) return null
  return (
    <ul className={css.menu} data-session-tree-branch-menu={group.sourceId}>
      <li className={css.menuHeaderItem}>
        <button
          type="button"
          className={css.menuToggle}
          aria-expanded={expanded}
          aria-label={`${toggleLabel} - ${group.sourceTitle}`}
          title={toggleLabel}
          onClick={() => {
            holdScrollAnchorDuring(shellRef.current, branchMenuDuration(bodyRef.current?.scrollHeight ?? 0))
            onToggle(group.sourceId)
          }}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3.8 1.8 9.4 6l-5.6 4.2Z" fill="currentColor" />
          </svg>
          <span className={css.menuTitle}>{t('branch.menu.title')}</span>
          {activeRows.length === 0 ? null : (
            <span className={css.countChip} aria-label={`${activeRows.length} ${t('branch.tree.count')}`}>
              x{activeRows.length}
            </span>
          )}
          {completedCount === 0 ? null : (
            <span
              className={css.completedDot}
              role="img"
              aria-label={t('branch.menu.completed')}
              title={t('branch.menu.completed')}
              data-branch-menu-completed={completedCount}
            />
          )}
        </button>
      </li>
      <li
        ref={shellRef}
        className={css.menuBody}
        data-expanded={expanded}
        aria-hidden={!expanded}
        data-session-tree-branch-body
      >
        <ul className={css.menuList} ref={bodyRef}>
          {tree.nodes}
          {restoredCount === 0 || !showArchived ? null : (
            <li>
              <div className={css.archivedBlock}>
            <div className={css.archivedHeader}>
              <span className={css.archivedLabel}>
                {t('branch.archived.label').replace('{count}', String(restoredCount))}
              </span>
              <button
                type="button"
                className={css.archivedInfo}
                title={t('branch.archived.hint')}
                aria-label={t('branch.archived.hint')}
              >
                <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
                  <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" />
                  <path d="M7 6.2v3.4M7 4.4v.1" stroke="currentColor" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <ul className={css.archivedList}>
              {groupArchivedForks.map(entry => (
                <li key={entry.childId} className={css.archivedRow}>
                  <span className={css.archivedTitle} title={entry.summary ?? entry.childId}>{parentNameOf(entry)}</span>
                  <button
                    type="button"
                    className={css.archivedRestore}
                    aria-label={`${t('branch.archived.restore')} - ${parentNameOf(entry)} · ${entry.summary ?? entry.childId}`}
                    onClick={() => { unarchive?.(entry.childId) }}
                  >{t('branch.archived.restore')}</button>
                </li>
              ))}
                </ul>
              </div>
            </li>
          )}
        </ul>
      </li>
    </ul>
  )
}

export type SessionBranchListProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'session-tree'>
  & {
    /** /fork annotation registry shared with the fork completion wiring. */
    lineage: SessionForkLineage
    /** Open one Session through the official Session Controller. */
    openSession: (sessionId: SessionId) => void
    /** Native catalog store; the runtime registration injects it. */
    sessions?: { readonly list: { subscribe(listener: () => void): () => void; getSnapshot(): SessionListState } } | undefined
    /** Test-facing selector hook; runtime uses `sessions.list` instead. */
    useSessions?: (<T>(selector: (state: SessionListState) => T) => T) | undefined
    /** Native menu retains archive confirmation, permissions and undo. */
    openSessionMenu?: OpenSessionMenu | undefined
    archiveSource?: ArchiveSource | undefined
    /** Restore one archived fork from the branch menu. */
    unarchive?: ((sessionId: SessionId) => void) | undefined
  }

/**
 * Portal inline /fork menus into the native session list. The component
 * renders no root DOM of its own; it keeps observers and hooks mounted while
 * no branches exist so the first fork appears without a refresh.
 */
export function SessionBranchList({
  lineage,
  openSession,
  openSessionMenu,
  archiveSource,
  unarchive,
  sessions,
  useSessions,
  useSessionStatus,
  t,
}: SessionBranchListProps) {
  const storedEntries = useSyncExternalStore(lineage.subscribe, lineage.getSnapshot, lineage.getSnapshot)
  // The overlay slot does not receive the native workspace hook. Runtime reads
  // the catalog store directly; the hook stays for direct test mounts.
  if (sessions === undefined && useSessions === undefined) {
    throw new Error('session-tree branch list requires the Session catalog')
  }
  // Store methods read `this`; pass closures, never detached methods.
  const catalog = sessions?.list
  const subscribeCatalog = useMemo(
    () => catalog === undefined ? undefined : (listener: () => void) => catalog.subscribe(listener),
    [catalog],
  )
  const readCatalog = useMemo(
    () => catalog === undefined ? undefined : () => catalog.getSnapshot(),
    [catalog],
  )
  const state = subscribeCatalog !== undefined && readCatalog !== undefined
    ? useSyncExternalStore(subscribeCatalog, readCatalog, readCatalog)
    : useSessions!(listState => listState)
  // localStorage is origin-scoped, and the desktop origin changes port on
  // restart. Rebuild /fork annotations from the native child id shape so the
  // inline branch list survives those restarts.
  const recordedEntries = useMemo(() => {
    const byId = state.byId ?? {}
    const merged = new Map(storedEntries)
    for (const id of state.ids ?? []) {
      if (merged.has(id)) continue
      const match = /^(.*)-fork-[a-z0-9]+-[a-z0-9]{6}$/u.exec(id)
      if (match === null) continue
      const parentId = match[1] as SessionId
      if (byId[parentId] === undefined) continue
      merged.set(id, {
        childId: id,
        parentId,
        createdAt: byId[id]?.updatedAt ?? 0,
      })
    }
    return merged
  }, [storedEntries, state])
  // Workspace store methods also read `this`; detaching getSnapshot crashes on
  // refreshSnapshot. Bind through closures.
  const archiveSubscribe = useMemo(
    () => archiveSource === undefined ? undefined : (listener: () => void) => archiveSource.subscribe(listener),
    [archiveSource],
  )
  const archiveRead = useMemo(
    () => archiveSource === undefined ? undefined : () => archiveSource.getSnapshot(),
    [archiveSource],
  )
  const archives = useSyncExternalStore(
    archiveSubscribe ?? noArchiveSubscribe,
    archiveRead ?? noArchiveSnapshot,
    archiveRead ?? noArchiveSnapshot,
  )
  // Archived forks return to the native archived list, whose filter and
  // unarchive action remain authoritative. Keep the lineage for restoration.
  const archivedForks = [...recordedEntries.values()].filter(entry =>
    archives.archivedSessionIds.includes(entry.childId))
  const [collapsed, setCollapsed] = useState<ReadonlySet<SessionId>>(() => new Set())
  // Expanded menus live in a page-process module store so collapsing a
  // workspace (which unmounts the native rows and this portal) keeps them; a
  // host restart or page reload starts with every menu collapsed.
  const openMenus = useSyncExternalStore(
    subscribeBranchMenus,
    branchMenusSnapshot,
    branchMenusSnapshot,
  )
  const [hosts, setHosts] = useState<ReadonlyMap<SessionId, HTMLElement>>(() => new Map())
  // Show archived forks only while the native list itself shows archived rows
  // (workspace filter "show/only"). Under the default "hide archived" filter
  // the host removes those rows, so the branch menu must not resurrect them.
  const [archivedRowsVisible, setArchivedRowsVisible] = useState(false)
  const hostsRef = useRef<ReadonlyMap<SessionId, HTMLElement>>(hosts)
  const hiddenRows = useRef(new Map<HTMLElement, HiddenRow>())
  const compensations = useRef(new Map<HTMLElement, Animation>())
  const compensationFrame = useRef(0)
  const matchedRows = useRef(new WeakMap<HTMLElement, SessionId>())
  const rebuildRef = useRef<() => void>(() => {})

  const topics = useSyncExternalStore(subscribeBranchTopics, branchTopics, branchTopics)
  // Completion reminders come from the Host's unified Session status, so a
  // finished background fork shows the same green dot as a native row.
  const statuses = useSessionStatus === undefined
    ? EMPTY_STATUSES
    : useSessionStatus(value => value)
  const { groups } = useMemo(
    () => branchGroups(state, recordedEntries, topics, statuses, index => `${t('branch.node.forkBadge')} ${index}`),
    [state, recordedEntries, topics, statuses, t],
  )
  // A group with at least one live fork always shows its menu. A group whose
  // forks are all archived shows the menu only while the native list itself
  // shows archived rows ("all conversations" / "archived only"), where the
  // restore section is meaningful. Archived parents of live descendants stay
  // in the model so those descendants remain reachable.
  const archivedIdSet = useMemo(
    () => new Set(archives.archivedSessionIds),
    [archives],
  )
  const archivedSourceIds = useMemo(() => {
    const sources = new Set<SessionId>()
    for (const entry of recordedEntries.values()) {
      if (!archives.archivedSessionIds.includes(entry.childId)) continue
      sources.add(forkSourceOf(entry, recordedEntries))
    }
    return sources
  }, [archives, recordedEntries])
  const visibleGroups = useMemo(
    () => groups.filter(group => group.rows.some(row => !archivedIdSet.has(row.sessionId))
      || (archivedRowsVisible && archivedSourceIds.has(group.sourceId))),
    [groups, archivedIdSet, archivedRowsVisible, archivedSourceIds],
  )

  const restoreHiddenRows = (): void => {
    for (const [row, hidden] of hiddenRows.current) {
      if (row.isConnected) {
        row.style.display = hidden.display
        row.removeAttribute(HIDDEN_ATTRIBUTE)
        row.removeAttribute(PREVIOUS_DISPLAY_ATTRIBUTE)
      }
    }
    hiddenRows.current.clear()
  }

  /**
   * Native row movement is measured by the Workspace list before this plugin
   * inserts a menu or hides the original fork row. Replay that movement after
   * the next frame, when the portals have mounted and the layout is final, so
   * rows continue from their visible position instead of the stale target.
   */
  const scheduleRowCompensation = (rows: readonly HTMLElement[]): void => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return
    if (compensationFrame.current !== 0) window.cancelAnimationFrame(compensationFrame.current)
    compensationFrame.current = window.requestAnimationFrame(() => {
      compensationFrame.current = 0
      for (const row of rows) {
        if (!row.isConnected || row.style.display === 'none') continue
        if (typeof row.animate !== 'function') continue
        const visual = row.getBoundingClientRect()
        const opacity = Number(window.getComputedStyle(row).opacity)
        if (typeof row.getAnimations === 'function') {
          for (const animation of row.getAnimations()) animation.cancel()
        }
        compensations.current.delete(row)
        const layout = row.getBoundingClientRect()
        const dx = visual.left - layout.left
        const dy = visual.top - layout.top
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
        const playback = row.animate(
          [
            {
              transform: `translate(${dx}px, ${dy}px)`,
              opacity: Number.isFinite(opacity) ? opacity : 1,
            },
            { transform: 'translate(0, 0)', opacity: 1 },
          ],
          { duration: 200, easing: 'ease-out' },
        )
        compensations.current.set(row, playback)
        playback.onfinish = () => {
          if (compensations.current.get(row) === playback) compensations.current.delete(row)
        }
      }
    })
  }

  useLayoutEffect(() => {
    const rebuild = (): void => {
      const rows = nativeSessionRows()
      // Prefer the native row key (`session:<id>`): title/order pairing breaks
      // when a workspace collapses and re-renders rows with duplicate titles.
      const rowById = new Map<SessionId, HTMLElement>()
      const unidentified: HTMLElement[] = []
      for (const row of rows) {
        const key = row.getAttribute('data-row-key')
        if (key !== null && key.startsWith('session:')) {
          rowById.set(key.slice('session:'.length) as SessionId, row)
        } else unidentified.push(row)
      }
      if (unidentified.length > 0) {
        const rowIds = matchNativeRows(unidentified, state, matchedRows.current)
        for (const [row, id] of rowIds) rowById.set(id, row)
      }
      const nextArchivedRowsVisible = archives.archivedSessionIds.some(id => rowById.has(id))
      setArchivedRowsVisible(current => current === nextArchivedRowsVisible ? current : nextArchivedRowsVisible)

      const hostSessions = new Set<SessionId>()
      for (const group of visibleGroups) {
        const sourceRow = rowById.get(group.sourceId)
        if (sourceRow !== undefined && sourceRow.parentElement !== null) hostSessions.add(group.sourceId)
      }
      const represented = new Set<SessionId>()
      if (openSessionMenu !== undefined) {
        for (const group of visibleGroups) {
          if (!hostSessions.has(group.sourceId)) continue
          for (const row of group.rows) {
            if (archives.archivedSessionIds.includes(row.sessionId)) continue
            represented.add(row.sessionId)
          }
        }
      }

      // Do nothing unless the plugin layout itself changes; unrelated native
      // re-renders must keep their own animations untouched.
      let changed = hostsRef.current.size !== hostSessions.size
      if (!changed) {
        for (const [sourceId, host] of hostsRef.current) {
          const sourceRow = rowById.get(sourceId)
          if (
            sourceRow === undefined
            || host.parentElement !== sourceRow.parentElement
            || host.previousElementSibling !== sourceRow
          ) {
            changed = true
            break
          }
        }
      }
      if (!changed) {
        const currentHidden = new Set<SessionId>()
        for (const [row, hidden] of hiddenRows.current) {
          if (row.isConnected) currentHidden.add(hidden.sessionId)
        }
        changed = currentHidden.size !== represented.size
        if (!changed) {
          for (const id of represented) {
            const row = rowById.get(id)
            if (row === undefined || row.style.display !== 'none') {
              changed = true
              break
            }
          }
        }
      }
      if (!changed) return

      restoreHiddenRows()

      const nextHosts = new Map<SessionId, HTMLElement>()
      for (const group of visibleGroups) {
        if (!hostSessions.has(group.sourceId)) continue
        const sourceRow = rowById.get(group.sourceId)
        const parent = sourceRow?.parentElement
        if (sourceRow === undefined || parent === null || parent === undefined) continue
        let host = hostsRef.current.get(group.sourceId)
        if (host === undefined) {
          host = document.createElement('div')
          host.className = css.host ?? ''
          host.dataset.sessionTreeBranchHost = 'mounted'
        }
        host.dataset.sessionTreeBranchTarget = group.sourceId
        // Every menu, including an archived-only one, belongs directly under
        // its own parent Session row.
        if (
          host.parentElement !== parent
          || host.previousElementSibling !== sourceRow
        ) {
          parent.insertBefore(host, sourceRow.nextSibling)
        }
        nextHosts.set(group.sourceId, host)
      }

      for (const [sourceId, host] of hostsRef.current) {
        if (!nextHosts.has(sourceId)) host.remove()
      }
      hostsRef.current = nextHosts
      setHosts(current => sameHosts(current, nextHosts) ? current : nextHosts)

      for (const id of represented) {
        if (openSessionMenu === undefined) continue
        const row = rowById.get(id)
        if (row === undefined) continue
        const display = row.style.display
        hiddenRows.current.set(row, { sessionId: id, display })
        row.setAttribute(HIDDEN_ATTRIBUTE, id)
        row.setAttribute(PREVIOUS_DISPLAY_ATTRIBUTE, display)
        row.style.display = 'none'
      }

      scheduleRowCompensation(rows)
    }

    rebuildRef.current = rebuild
    rebuild()
    return restoreHiddenRows
  }, [visibleGroups, state, openSessionMenu, archives])

  useEffect(() => {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return
    const observer = new MutationObserver(mutations => {
      const nativeChange = mutations.some(mutation => {
        const target = mutation.target
        const element = target.nodeType === Node.ELEMENT_NODE
          ? target as Element
          : target.parentElement
        return element?.closest(BRANCH_HOST) === null
      })
      if (nativeChange) rebuildRef.current()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [])

  useLayoutEffect(() => () => {
    if (compensationFrame.current !== 0) window.cancelAnimationFrame(compensationFrame.current)
    compensationFrame.current = 0
    for (const animation of compensations.current.values()) animation.cancel()
    compensations.current.clear()
    restoreHiddenRows()
    for (const host of hostsRef.current.values()) host.remove()
    hostsRef.current = new Map()
  }, [])

  if (typeof document === 'undefined' || visibleGroups.length === 0) return null

  const toggle = (sessionId: SessionId): void => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  const toggleMenu = (sessionId: SessionId): void => {
    toggleBranchMenu(sessionId)
  }

  return (
    <>
      {visibleGroups.map(group => {
        if (group.rows.length === 0) return null
        const host = hosts.get(group.sourceId)
        if (host === undefined) return null
        return createPortal(
          <BranchMenu
            group={group}
            expanded={openMenus.has(group.sourceId)}
            collapsed={collapsed}
            onToggle={toggleMenu}
            onToggleRow={toggle}
            onOpen={openSession}
            openSessionMenu={openSessionMenu}
            archivedForks={archivedForks}
            allEntries={recordedEntries}
            titleOf={id => state.byId?.[id]?.displayTitle ?? id}
            archivedIds={archivedIdSet}
            showArchived={archivedRowsVisible}
            unarchive={unarchive}
            t={t}
          />,
          host,
          group.sourceId,
        )
      })}
    </>
  )
}
