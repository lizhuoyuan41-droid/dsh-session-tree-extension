/** Browser half of the session-tree extension: a right-details-sidebar panel. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import sessionTreeRemote from '@ryanlee2007/dsh-pi-agent-session-tree/remote'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { CommandResult } from '@deepseek-ai/dsh-commands/types'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'command/executed'(sessionId: SessionId, name: string, result: CommandResult): void
  }
}
import type { SessionTreeForkView, SessionTreeView, TreeNode } from '@ryanlee2007/dsh-pi-agent-session-tree/client'
import { nodeFullText, isInjectedUserSource } from './node-text.ts'
import { SessionForkLineage, browserForkLineageStorage, summarizeForkPrompt } from './fork-lineage.ts'
import type { SessionTreePanelActions } from './slots.ts'
import { SessionTreeDock } from './SessionTreePanel.tsx'
import { SessionTreeSidebarTab } from './SessionTreeSidebarTab.tsx'
import { SessionBranchList } from './SessionBranchList.tsx'
import {
  SessionTreeOverlay,
  SessionTreeOverlayController,
  type SessionTreeRemoteActions,
} from './SessionTreeOverlay.tsx'
import { en, zh, type SessionTreeKey } from './locales.ts'
import { forkNodeForTurn, installChatForkBridge } from './chat-fork.ts'
import { nativeTurnForSeq, navigateNativeTurn, waitForVisiblePage } from './node-navigation.ts'
import { archiveCascadeTargets, currentSessionId } from './session-list.ts'

export { SessionTreePanel, SessionTreeDock } from './SessionTreePanel.tsx'
export { SessionTreeOverlay, SessionTreeOverlayController } from './SessionTreeOverlay.tsx'
export type { SessionTreeOverlayProps, SessionTreeOverlayState } from './SessionTreeOverlay.tsx'
export { SessionBranchList } from './SessionBranchList.tsx'
export { buildBranchTreeModel, buildSessionGraphModel, visibleBranchRows } from './session-graph.ts'
export type {
  BranchTreeBadge,
  BranchTreeListState,
  BranchTreeModel,
  BranchTreeRow,
  SessionGraphBadge,
  SessionGraphModel,
  SessionGraphPlaceholder,
  SessionGraphRow,
} from './session-graph.ts'
export { SessionForkLineage, summarizeForkPrompt } from './fork-lineage.ts'
export type { SessionBranchListProps } from './SessionBranchList.tsx'
export type { ForkLineageEntry, ForkLineageRecordInput, ForkLineageStorage } from './fork-lineage.ts'
export type { SessionTreePanelActions, SessionTreeViewProps } from './slots.ts'
export type { SessionTreeKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'session-tree': SessionTreeKey }
}

const NS = 'session-tree'
// Optional 0.2 right-Sidebar and Workspace faces are read through `ctx.get()`;
// Cordis 4 rejects probing an undeclared service with `Reflect.has(ctx, name)`
// and then reading it, even when the service is present.
export const inject = ['slots', 'sessions', 'conversation', 'remote', 'locale', 'layout']

/** Runtime-only editor face exposed by the native SessionInput shell. */
interface NativeSessionInput {
  readonly editor?: {
    parseEditorState(value: unknown): unknown
    setEditorState(state: unknown): void
    getRootElement?(): HTMLElement | null
  }
}

interface SessionTreeLayoutActions {
  readonly openDetails?: (panel?: string) => void
  readonly openRightbar?: (track: boolean, fullscreen: boolean) => void
}

/**
 * Open a Session through 0.2 Workspace navigation, or the legacy sessions face.
 * `ctx.get` is the inject-free lookup for a service this plugin treats as
 * optional; Cordis' proxy throws on `Reflect.has` + property reads otherwise.
 */
function revealSession(ctx: ClientContext, sessionId: SessionId): void {
  const workspace = ctx.get('uiWorkspace')
  if (workspace !== undefined) {
    workspace.openSession(sessionId)
    return
  }
  ;(ctx.sessions as unknown as { open(id: SessionId): void }).open(sessionId)
}

/** Reveal the native session-tree surface across patched and official layouts. */
function openSessionTreePanel(ctx: ClientContext, layout: SessionTreeLayoutActions): void {
  const sidebarRight = ctx.get('sidebarRight')
  if (sidebarRight !== undefined) {
    sidebarRight.openTab('session-tree')
    return
  }
  if (layout.openDetails !== undefined) {
    layout.openDetails('session-tree')
    return
  }
  layout.openRightbar?.(true, false)
}

/** Build the serialized Lexical state used to seed one native composer. */
function editorStateForText(text: string): unknown {
  return {
    root: {
      children: text.split('\n').map(line => ({
        children: line === ''
          ? []
          : [{
              detail: 0,
              format: 0,
              mode: 'normal',
              style: '',
              text: line,
              type: 'text',
              version: 1,
            }],
        direction: null,
        format: '',
        indent: 0,
        textFormat: 0,
        textStyle: '',
        type: 'paragraph',
        version: 1,
      })),
      direction: null,
      format: '',
      indent: 0,
      textFormat: 0,
      textStyle: '',
      type: 'root',
      version: 1,
    },
  }
}

/** Register UI only after the generated Remote namespace has been mounted. */
function registerSessionTreeUi(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-session-tree: dictionaries')
  const refreshers = new Map<SessionId, Set<() => void>>()
  ctx.effect(() => () => { refreshers.clear() }, 'ui-session-tree: refreshers')
  const overlay = new SessionTreeOverlayController()
  ctx.effect(() => () => { overlay.dispose() }, 'ui-session-tree: overlay state')
  // /fork presentation annotations for the inline session-list menus. The
  // fork data and parent linkage stay owned by ctx.sessions.fork; only the
  // /fork-vs-/clone distinction and the branch title live here.
  const forkLineage = new SessionForkLineage(browserForkLineageStorage())
  ctx.effect(() => () => { forkLineage.dispose() }, 'ui-session-tree: fork lineage')

  /** Write a fork prompt through the child Session's native editor instance. */
  const writeNativePrompt = (sessionId: SessionId, text: string): void => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error('fork child is not addressable')
    const input = ctx.conversation.input.for(binding.ctx) as unknown as NativeSessionInput
    const editor = input.editor
    if (editor === undefined) throw new Error('fork child native input editor is unavailable')
    editor.setEditorState(editor.parseEditorState(editorStateForText(text)))
  }

  /** Seed the new fork's native composer before revealing it. */
  const completeFork = async (result: SessionTreeForkView): Promise<void> => {
    const childId = result.sessionId
    if (childId === undefined) return
    // A remote-created child is not retained by the Client yet. Refresh its
    // catalog row and hold a binding while preparing the native composer.
    if (typeof ctx.sessions.refresh === 'function') await ctx.sessions.refresh()
    const prepare = (): void => {
      try {
        if (result.prompt !== undefined) writeNativePrompt(childId, result.prompt)
      } catch {
        // The composer seed is best-effort: never block revealing a fork whose
        // binding is still settling after the catalog refresh.
      }
      revealSession(ctx, childId)
    }
    if (typeof ctx.sessions.using === 'function') {
      await ctx.sessions.using(childId, { source: 'controllerOperation' }, async reference => {
        await reference.ready
        prepare()
      })
    } else prepare()
  }

  /** Fork through the same native session service used by the sidebar menu. */
  const forkNative = async (sessionId: SessionId, atSeq?: number): Promise<SessionId> => {
    return ctx.sessions.fork({
      sessionId,
      ...(atSeq === undefined ? {} : { atSeq }),
      increaseTitle: true,
    })
  }

  /** Fork and reveal a child without an editable prompt. */
  const openNativeFork = async (sessionId: SessionId, atSeq?: number): Promise<SessionId> => {
    const childId = await forkNative(sessionId, atSeq)
    revealSession(ctx, childId)
    return childId
  }

  /**
   * Restore the native fork to the completed turn immediately before the
   * selected user message, then seed the child composer with that message.
   */
  const forkUserPrompt = async (sessionId: SessionId, node: TreeNode): Promise<void> => {
    const selectedSeq = node.metadata?.sessionEventSeq
    if (typeof selectedSeq !== 'number' || !Number.isSafeInteger(selectedSeq)) {
      throw new Error('selected user message has no native event sequence')
    }

    const source = ctx.sessions.binding(sessionId)
    if (source === undefined) throw new Error('source session is not addressable')

    // Ensure the source event window covers the selected node before looking
    // for the previous completed-turn boundary.
    await source.session.loadThrough(SessionSeq(selectedSeq))
    const entries = source.eventSource.getSnapshot().entries
    let previousUserPrompt: string | undefined
    let previousTurnEnd: number | undefined
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]
      if (
        previousUserPrompt === undefined
        && entry?.type === 'event'
        && entry.event.type === 'user/message'
        && entry.event.seq < selectedSeq
        // The inline fork-menu title names the previous TYPED prompt; skip
        // harness injections (skill catalog, system-prompt snapshot).
        && !isInjectedUserSource(entry.event.data.source)
      ) {
        const text = entry.event.data.content
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join('\n')
          .trim()
        if (text !== '') previousUserPrompt = text
      }
      if (
        previousTurnEnd === undefined
        && entry?.type === 'event'
        && entry.event.type === 'turn/end'
        && entry.event.seq < selectedSeq
      ) {
        // Scanning backwards, the first match is the nearest completed turn.
        // Overwriting it with an earlier turn would drop image/tool-only turns
        // (no typed prompt between them) from the fork seed.
        previousTurnEnd = entry.event.seq
      }
      if (previousUserPrompt !== undefined && previousTurnEnd !== undefined) break
    }

    if (previousTurnEnd === undefined) {
      throw new Error('The native fork API cannot fork before the first completed turn')
    }

    // `atSeq` is the first turn/end at or after the anchor. Passing the prior
    // completed turn therefore restores context strictly before the selection.
    const childId = await forkNative(sessionId, previousTurnEnd)
    forkLineage.record({
      childId,
      parentId: sessionId,
      ...(previousUserPrompt === undefined ? {} : { summary: summarizeForkPrompt(previousUserPrompt) }),
    })
    writeNativePrompt(childId, nodeFullText(node))
    revealSession(ctx, childId)
    overlay.closeSelector()
  }

  const sendPrompt = async (sessionId: SessionId, text: string): Promise<void> => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error('session is not ready')
    const answered = await binding.session.prompt([{ type: 'text', text }], 'queue')
    if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
  }

  const remoteActions: SessionTreeRemoteActions = {
    load: async (sessionId) => {
      const answered = await ctx.remote.sessionTree.list(sessionId)
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value
    },
    jump: async (sessionId, nodeId) => {
      const answered = await ctx.remote.sessionTree.jump(sessionId, nodeId)
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value
    },
    fork: async (sessionId, nodeId, branch) => {
      const answered = await ctx.remote.sessionTree.forkSession(sessionId, nodeId, branch)
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      if (answered.value.sessionId !== undefined) {
        forkLineage.record({
          childId: answered.value.sessionId,
          parentId: sessionId,
          ...(answered.value.previousUserPrompt === undefined
            ? {}
            : { summary: summarizeForkPrompt(answered.value.previousUserPrompt) }),
          branch,
        })
      }
      return answered.value
    },
    onRefresh: (sessionId, callback) => {
      const set = refreshers.get(sessionId) ?? new Set<() => void>()
      set.add(callback); refreshers.set(sessionId, set)
      return () => { set.delete(callback); if (set.size === 0) refreshers.delete(sessionId) }
    },
  }

  // Route the native completed-turn footer through the same fork action as
  // the tree panel. No override hook exists on the 0.2.2 footer itself.
  if (typeof document !== 'undefined' && typeof ctx.locale.bind === 'function') {
    const chatText = ctx.locale.bind('chat')
    ctx.effect(() => installChatForkBridge(document, () => chatText('message.branch'), async (sessionId, turn) => {
      await ctx.sessions.using(sessionId, { source: 'controllerOperation' }, async reference => {
        await reference.ready
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined) throw new Error('源会话尚未就绪')
        // Native history supplies turn boundaries even for pre-turn-metadata
        // sidecars. Loading to the start also covers paginated older turns.
        await binding.session.loadThrough(SessionSeq(0))
        const view = await remoteActions.load(sessionId)
        const node = forkNodeForTurn(view, binding.eventSource.getSnapshot().entries, turn)
        const result = await remoteActions.fork(sessionId, node.nodeId, `fork-${Date.now().toString(36)}`)
        await completeFork(result)
      })
    }), 'ui-session-tree: chat footer fork')
  }

  // Archive membership as a small store shaped for the panel; the workspace
  // store itself exposes a wider snapshot.
  const workspaceList = ctx.get('workspaces')?.list
  const archivedSource = workspaceList === undefined ? undefined : {
    subscribe: (listener: () => void) => workspaceList.subscribe(listener),
    getSnapshot: () => workspaceList.getSnapshot().archivedSessionIds,
  }

  // Archiving a Session archives its whole session subtree. The native archive
  // action only touches one id, so watch newly archived ids and cascade the
  // descendants through the same workspace service. Existing archived ids are
  // seeded as already handled, so a restart never archives unrelated history.
  const workspaceService = ctx.get('workspaces')
  if (workspaceList !== undefined && workspaceService !== undefined) {
    ctx.effect(() => {
      let previous = new Set<SessionId>(workspaceList.getSnapshot().archivedSessionIds as readonly SessionId[])
      const pending = new Set<SessionId>()
      const unsubscribe = workspaceList.subscribe(() => {
        const current = new Set<SessionId>(workspaceList.getSnapshot().archivedSessionIds as readonly SessionId[])
        const listState = ctx.sessions.list.getSnapshot()
        const targets = new Set(
          archiveCascadeTargets(previous, current, listState).filter(id => !pending.has(id)),
        )
        previous = current
        if (targets.size === 0) return
        for (const id of targets) pending.add(id)
        void Promise.allSettled(
          [...targets].map(id => workspaceService.archiveSession(id)),
        ).finally(() => {
          for (const id of targets) pending.delete(id)
        })
      })
      return unsubscribe
    })
  }

  const activateTurn = (turn: number): Promise<void> =>
    navigateNativeTurn({ turn, getRoot: () => (typeof document === 'undefined' ? null : document.body) })

  /** Wait until the Session list itself reports `sessionId` as the main view. */
  const waitForCurrentSession = (sessionId: SessionId, signal: AbortSignal, timeoutMs = 10000): Promise<void> =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const tick = (): void => {
        if (signal.aborted) { reject(new DOMException('Navigation superseded', 'AbortError')); return }
        if (currentSessionId(ctx.sessions.list.getSnapshot()) === sessionId) { resolve(); return }
        if (Date.now() >= deadline) { reject(new Error('目标会话未能在超时内成为当前会话')); return }
        window.setTimeout(tick, 40)
      }
      tick()
    })

  interface NativeTurnPlan { readonly turn: number }

  /**
   * Resolve and load the target turn before switching pages. This keeps the
   * previous transcript visible only for the switch itself, not for history IO.
   */
  const prepareNode = async (sessionId: SessionId, node: TreeNode, signal = new AbortController().signal): Promise<NativeTurnPlan> => {
    return ctx.sessions.using(sessionId, { source: 'controllerOperation' }, async reference => {
      await reference.ready
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) throw new Error('目标会话尚未绑定')
      const seq = node.metadata?.sessionEventSeq
      if (typeof seq !== 'number') throw new Error('节点缺少原生事件序号，无法定位轮次')
      await binding.session.loadThrough(SessionSeq(seq))
      if (signal.aborted) throw new DOMException('Navigation superseded', 'AbortError')
      // Resolve from native events, including old sidecars without turn metadata.
      const turn = nativeTurnForSeq(binding.eventSource.getSnapshot().entries, seq)
      if (turn === undefined) throw new Error('目标节点没有对应的原生轮次')
      return { turn }
    })
  }

  const navigateNode = async (sessionId: SessionId, node: TreeNode, signal = new AbortController().signal, options: { expectCurrentSession?: boolean; expectText?: string; plan?: NativeTurnPlan } = {}): Promise<void> => {
    await ctx.sessions.using(sessionId, { source: 'controllerOperation' }, async reference => {
      await reference.ready
      // Data readiness is not page readiness. Observe the Session selection,
      // then wait for the visible transcript to mount and its restored reading
      // position to settle before touching the rail.
      if (options.expectCurrentSession !== false) await waitForCurrentSession(sessionId, signal)
      const prepared = options.plan ?? await prepareNode(sessionId, node, signal)
      await waitForVisiblePage({ signal, sessionId, quietMs: 80 })
      // The rail is a document-level surface; railViews filters it to the one
      // currently visible, so a retained hidden page can never receive the click.
      await navigateNativeTurn({ turn: prepared.turn, signal, verify: true, sessionId, settleMs: 300, retryMs: 500, maxClicks: 4, ...(options.expectText === undefined ? {} : { expectText: options.expectText }), getRoot: () => document.body })
    })
  }

  /** Compose the action face shared by the 0.2 right-Sidebar tab and legacy dock. */
  const panelActions = (sessionId: SessionId): SessionTreePanelActions => ({
    load: remoteActions.load,
    jump: nodeId => remoteActions.jump(sessionId, nodeId),
    jumpSession: remoteActions.jump,
    prepareNode,
    navigateNode,
    activateTurn,
    fork: async (nodeId, branch) => {
      const result = await remoteActions.fork(sessionId, nodeId, branch)
      await completeFork(result)
      return result
    },
    forkInSession: async (targetSessionId, nodeId, branch) => {
      const result = await remoteActions.fork(targetSessionId, nodeId, branch)
      await completeFork(result)
      return result
    },
    forkUserPrompt: node => forkUserPrompt(sessionId, node),
    modeController: overlay,
    onRefresh: callback => remoteActions.onRefresh(sessionId, callback),
    lineage: forkLineage,
    openSession: (id: SessionId) => { revealSession(ctx, id) },
    isArchived: (id: SessionId) =>
      workspaceList?.getSnapshot().archivedSessionIds.includes(id) === true,
    archivedSource,
  })

  const sidebarRightTabs = ctx.get('sidebarRightTabs')
  const sidebarRight = ctx.get('sidebarRight')
  if (sidebarRightTabs !== undefined && sidebarRight !== undefined) {
    // DeepSeek-Harness 0.2 ships an extensible right Sidebar. Register a page
    // type there so /tree docks into the product's own persistent surface.
    const SESSION_TREE_TAB_ID = '@ryanlee2007/dsh-client-ui-session-tree'
    const translate = typeof ctx.locale.bind === 'function'
      ? ctx.locale.bind(NS)
      : (key: SessionTreeKey) => zh[key]
    const title = translate('panel.title')
    ctx.effect(() => sidebarRightTabs.register({
      id: SESSION_TREE_TAB_ID,
      kind: 'session-tree',
      priority: 'extension',
      keepMounted: true,
      title: () => title,
      // 0.2.2 lists tab types on the right Sidebar's guide (start) page only
      // when the definition contributes an entry; without it the tab is
      // reachable through /tree but has no visible entry point.
      guide: [{
        id: 'session-tree',
        order: 20,
        title: () => title,
        description: () => translate('panel.guide'),
      }],
    }), 'ui-session-tree: right-sidebar type')
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: SESSION_TREE_TAB_ID, locale: NS,
      inject: panelActions,
    }, SessionTreeSidebarTab)), 'ui-session-tree: right-sidebar body')
    overlay.setNativePanel(true)
  }

  // Every supported official Web profile declares this additive root slot.
  // It remains a dormant fallback when the legacy source patch supplies the
  // richer named details-panel slot below.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'session-tree', order: 10, locale: NS,
    inject: () => ({
      controller: overlay,
      remoteActions,
      completeFork,
      forkUserPrompt,
      navigateNode,
      activateTurn,
      sendPrompt,
      openSession: (sessionId: SessionId) => { revealSession(ctx, sessionId) },
      lineage: forkLineage,
    }),
  }, SessionTreeOverlay))

  // Second additive shell.overlay entry: inline /fork menus under native
  // Session rows. It renders nothing until a /fork flow records a live branch,
  // so ordinary sessions and /clone children keep their native presentation.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'session-tree-branches', order: 11, locale: NS,
    inject: () => ({
      lineage: forkLineage,
      sessions: ctx.sessions,
      openSession: (sessionId: SessionId) => { revealSession(ctx, sessionId) },
      openSessionMenu: ctx.get('contextMenus') === undefined ? undefined
        : (sessionId: SessionId, displayTitle: string, point: { x: number; y: number }) => {
          ctx.get('contextMenus')?.open({ kind: 'session', value: { sessionId, displayTitle } }, point)
        },
      archiveSource: ctx.get('workspaces')?.list,
      unarchive: (id: SessionId) => { void ctx.get('workspaces')?.unarchiveSession(id) },
    }),
  }, SessionBranchList))

  // The legacy source patch owns this optional slot. Mirror its exact
  // declaration lifetime so HMR never shows both surfaces at once.
  ctx.slots.inject('conversation.details.panel' as never, () => {
    const disposePanel = ctx.slots.register({
      name: 'conversation.details.panel', id: 'session-tree', order: 10, locale: NS,
      inject: panelActions,
    } as never, SessionTreeDock as never)
    overlay.setNativePanel(true)
    return () => {
      disposePanel()
      overlay.setNativePanel(false)
    }
  })

  ctx.on('command/executed', (sessionId: SessionId, name: string, result: CommandResult) => {
    if (name === 'tree') {
      if (overlay.getSnapshot().nativePanel) {
        openSessionTreePanel(ctx, ctx.layout as unknown as SessionTreeLayoutActions)
      } else {
        overlay.open()
      }
    }
    if ((name === 'clone' || name === 'fork') && result.kind === 'success' && result.text !== undefined) {
      try {
        const payload = JSON.parse(result.text) as {
          value?: {
            sessionId?: string
            prompt?: string
            previousUserPrompt?: string
            selectorRequired?: boolean
            nativeForkRequired?: boolean
          }
        }
        if (payload.value?.selectorRequired === true) {
          overlay.openSelector()
          // In the native details-dock profile, /fork must also make the dock
          // visible; the selector state alone only switches the overlay drawer.
          if (overlay.getSnapshot().nativePanel) {
            openSessionTreePanel(ctx, ctx.layout as unknown as SessionTreeLayoutActions)
          }
        }
        else if (payload.value?.nativeForkRequired === true) {
          void openNativeFork(sessionId).catch(() => {
            // Match the sidebar action: a failed fork leaves the source open.
          })
        }
        else if (typeof payload.value?.sessionId === 'string') {
          const childId = payload.value.sessionId as SessionId
          if (name === 'fork') {
            forkLineage.record({
              childId,
              parentId: sessionId,
              ...(payload.value.previousUserPrompt === undefined
                ? {}
                : { summary: summarizeForkPrompt(payload.value.previousUserPrompt) }),
            })
          }
          completeFork({
            cursor: '', branch: '', forkCount: 0,
            sessionId: childId,
            ...(payload.value.prompt === undefined ? {} : { prompt: payload.value.prompt }),
          })
        }
      } catch {
        // A non-JSON success is still a valid Host outcome; it simply has no navigable fork id.
      }
    }
    if (name === 'tree' || name === 'fork' || name === 'clone') {
      for (const refresh of refreshers.get(sessionId) ?? []) refresh()
    }
  })
}

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(sessionTreeRemote)
  // `remote.sessionTree` is created by $mount above. Cordis nested services must
  // be declared explicitly, so consume it from a child injection scope rather
  // than reading it from the outer scope that only injects `remote`.
  const ui = ctx.inject(
    ['slots', 'sessions', 'conversation', 'remote.sessionTree', 'locale', 'layout'],
    registerSessionTreeUi,
  )
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await unmountRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await unmountRemote()
  }
}

export type LoadedSessionTreeView = SessionTreeView
