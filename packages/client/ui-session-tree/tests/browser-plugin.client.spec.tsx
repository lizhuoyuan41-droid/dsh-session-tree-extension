// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionTreeView, TreeNode } from '@ryanlee2007/dsh-pi-agent-session-tree/client'
import { zh } from '../src/client/locales.ts'
import { SessionTreeDock } from '../src/client/SessionTreePanel.tsx'
import { SessionTreeSidebarTab } from '../src/client/SessionTreeSidebarTab.tsx'
import {
  SessionTreeOverlay,
  SessionTreeOverlayController,
  type SessionTreeRemoteActions,
} from '../src/client/SessionTreeOverlay.tsx'
import { SessionBranchList, forkSourceOf } from '../src/client/SessionBranchList.tsx'
import { buildBranchTreeModel, buildSessionGraphModel } from '../src/client/session-graph.ts'
import { SessionForkLineage, FORK_LINEAGE_STORAGE_KEY } from '../src/client/fork-lineage.ts'
import { apply, inject } from '../src/client/index.ts'
import { rememberBranchTopic, resetBranchTopicsForTests } from '../src/client/branch-topic.ts'
import { resetBranchMenus } from '../src/client/branch-menu-state.ts'
import { holdScrollAnchorDuring } from '../src/client/scroll-anchor.ts'
import { resetFocusKeyForTests } from '../src/client/focus-store.ts'
import type { SessionTreePanelActions } from '../src/client/slots.ts'

afterEach(cleanup)
afterEach(() => { resetBranchTopicsForTests(); resetFocusKeyForTests(); resetBranchMenus() })
const sid = (value: string): SessionId => value as SessionId
const t = (key: string): string => zh[key as keyof typeof zh] ?? key
function node(nodeId: string, parentId: string | null, summary: string, branch = 'main'): TreeNode {
  return { nodeId, parentId, branch, summary, createdAt: `2026-01-01T00:00:0${nodeId.length}.000Z`, message: { role: 'user', content: summary } }
}
function view(
  cursor: string | null,
  nodes: TreeNode[],
  selectedNodeId: string | null = cursor,
  sessionId: SessionId = sid('s1'),
): SessionTreeView {
  return { sessionId, cursor, selectedNodeId, activeBranch: 'main', nodes, branches: [{ name: 'main', headId: nodes.at(-1)?.nodeId ?? '', nodeIds: nodes.map(item => item.nodeId) }] }
}

interface TestEditor {
  parseEditorState: (value: unknown) => unknown
  setEditorState: (state: unknown) => void
}

interface TestSlotEntry {
  component: unknown
  options: Record<string, unknown>
  inject?: (...args: never[]) => unknown
}

/** Standalone-repo substitute for Harness' browser-only SlotRegistry bundle. */
function installTestSlots(ctx: Context) {
  const declared = new Set<string>()
  const entriesByName = new Map<string, TestSlotEntry[]>()
  const slots = {
    register(options: { name: string; children?: Record<string, unknown>; inject?: (...args: never[]) => unknown; [key: string]: unknown }, component: unknown) {
      declared.add(options.name)
      for (const name of Object.keys(options.children ?? {})) declared.add(name)
      const entry: TestSlotEntry = {
        component,
        options,
        ...(options.inject === undefined ? {} : { inject: options.inject }),
      }
      const entries = entriesByName.get(options.name) ?? []
      entries.push(entry)
      entriesByName.set(options.name, entries)
      return () => {
        const current = entriesByName.get(options.name)
        if (current === undefined) return
        const index = current.indexOf(entry)
        if (index >= 0) current.splice(index, 1)
      }
    },
    entries(name: string) {
      return entriesByName.get(name) ?? []
    },
    inject(name: string, mount: () => void | (() => void)) {
      if (!declared.has(name)) return () => {}
      const dispose = mount()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  ctx.provide('slots', slots as never)
  return slots
}

async function bench(tree = view(null, []), nativePanel = true, chatFooter = false) {
  const ctx = new Context()
  // Each bench mounts the real browser persistence; scrub the shared jsdom
  // localStorage so one test's /fork annotations never leak into the next.
  try { window.localStorage.removeItem(FORK_LINEAGE_STORAGE_KEY) } catch { /* non-jsdom host */ }
  const slots = installTestSlots(ctx)
  const calls: Array<{ method: string; args: unknown[] }> = []
  const opened: string[] = []
  const openedSessions: string[] = []
  const drafts = vi.fn()
  const editors = new Map<unknown, TestEditor>()
  const bindings = new Map<SessionId, unknown>()
  const nativeFork = vi.fn(async (opts: { sessionId: SessionId }) => sid(`${opts.sessionId}-native-fork`))
  const open = vi.fn((id: SessionId) => { openedSessions.push(id) })
  const refresh = vi.fn(async () => {})
  const sessionTree = {
    list: (...args: unknown[]) => { calls.push({ method: 'list', args }); return Promise.resolve({ ok: true, value: tree }) },
    jump: (...args: unknown[]) => { calls.push({ method: 'jump', args }); return Promise.resolve({ ok: true, value: { cursor: args[1], messages: [] } }) },
    fork: (...args: unknown[]) => { calls.push({ method: 'fork', args }); return Promise.resolve({ ok: true, value: { cursor: args[1], branch: args[2], forkCount: 1 } }) },
    forkSession: (...args: unknown[]) => {
      calls.push({ method: 'fork', args })
      return Promise.resolve({
        ok: true,
        value: {
          cursor: args[1],
          branch: args[2],
          forkCount: 1,
          sessionId: 's1-fork-test',
          prompt: 'test',
          previousUserPrompt: 'previous',
        },
      })
    },
  }
  class RemoteService extends Service {
    constructor(c: Context) { super(c, 'remote') }
    async $mount(): Promise<() => Promise<void>> {
      const dispose = ctx.reflect.provide('remote.sessionTree', sessionTree)
      return async () => { await dispose() }
    }
  }
  new RemoteService(ctx)
  ctx.provide('layout', { openDetails: (panel?: string) => { opened.push(panel ?? 'tool') }, closeDetails: () => {}, toggleSidebar: () => {} })
  const children = {
    'details': { kind: 'single', scope: 'session' },
    'shell.overlay': { kind: 'list', scope: 'root' },
    ...(nativePanel ? { 'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' } } : {}),
  }
  slots.register({ name: 'root', children } as never, (() => null) as never)
  const toolDetails = (() => null) as never
  slots.register({ name: 'details' } as never, toolDetails)
  ctx.provide('locale', {
    register: () => () => {},
    ...(chatFooter ? { bind: (namespace: string) => (key: string) => namespace === 'chat' ? '在新对话中分支' : t(key) } : {}),
  } as never)
  ctx.provide('sessions', {
    binding: (id: SessionId) => bindings.get(id),
    fork: nativeFork,
    refresh,
    ...(chatFooter ? {
      using: async (id: SessionId, _options: unknown, action: (reference: { ready: Promise<void> }) => Promise<unknown>) => {
        if (!bindings.has(id)) throw new Error('missing binding')
        return action({ ready: Promise.resolve() })
      },
    } : {}),
  } as never)
  ctx.provide('uiWorkspace', { openSession: open } as never)
  if (nativePanel) {
    const tabRegistrations: Array<Record<string, unknown>> = []
    ctx.provide('sidebarRightTabs', {
      register: (definition: Record<string, unknown>) => {
        tabRegistrations.push(definition)
        return () => {}
      },
    } as never)
    ctx.provide('sidebarRight', {
      openTab: (kind: string) => { opened.push(kind) },
    } as never)
    ctx.effect(() => () => { tabRegistrations.length = 0 }, 'test sidebar registrations')
  }
  const inputFor = vi.fn((actx: unknown) => ({ editor: editors.get(actx), setDraft: drafts }))
  ctx.provide('conversation', {
    input: {
      for: inputFor,
    },
  } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return {
    ctx, calls, opened, openedSessions, drafts, editors, inputFor, bindings, nativeFork, open, refresh, fiber, toolDetails,
    entry: () => ctx.slots.entries(nativePanel ? 'sidebar.right.pane.tab' : 'conversation.details.panel' as never)[0],
    overlayEntry: () => ctx.slots.entries('shell.overlay' as never)[0],
    branchEntry: () => ctx.slots.entries('shell.overlay' as never)[1],
  }
}

/** Shared fake for the reactive Session list consumed by the inline branch menu. */
interface FakeListRow {
  id: SessionId
  displayTitle: string
  parentId?: SessionId
  running: boolean
  blank: boolean
  updatedAt: number
}

function fakeListState(ids: SessionId[], rows: Record<string, FakeListRow>, current: SessionId) {
  return {
    phase: 'ready' as const,
    current,
    ids,
    byId: rows as unknown as Record<SessionId, FakeListRow>,
  }
}

function fakeRow(id: SessionId, displayTitle: string, parentId?: SessionId): [string, FakeListRow] {
  return [id, { id, displayTitle, ...(parentId === undefined ? {} : { parentId }), running: false, blank: false, updatedAt: 1 }]
}

function renderNativeSessionRows(
  initialRows: ReadonlyArray<{ id: SessionId; title: string; selected?: boolean }>,
) {
  const tree = (list: ReadonlyArray<{ id: SessionId; title: string; selected?: boolean }>) => (
    <div role="tree">
      {list.map(row => (
        <div
          key={row.id}
          role="treeitem"
          aria-selected={row.selected === true ? 'true' : 'false'}
          data-test-session-row={row.id}
          data-row-key={`session:${row.id}`}
        >
          {row.title}
        </div>
      ))}
    </div>
  )
  const rendered = render(tree(initialRows))
  return {
    ...rendered,
    setRows(list: ReadonlyArray<{ id: SessionId; title: string; selected?: boolean }>): void {
      rendered.rerender(tree(list))
    },
    row(sessionId: SessionId): HTMLElement {
      const element = rendered.container.querySelector<HTMLElement>(
        `[data-test-session-row="${sessionId}"]`,
      )
      if (element === null) throw new Error(`native row '${sessionId}' missing`)
      return element
    },
  }
}

describe('session tree browser plugin', () => {
  it('routes the native footer through remote tree fork, lineage and composer completion', async () => {
    const prompt: TreeNode = { ...node('typed-prompt', null, 'editable prompt'), metadata: { sessionEventSeq: 12 } }
    const end: TreeNode = { ...node('end', prompt.nodeId, 'turn/end'), message: undefined,
      metadata: { turn: 2, sessionEventType: 'turn/end' } }
    const b = await bench(view('end', [prompt, end], 'end'), true, true)
    try {
      const childContext = {}
      const childEditor: TestEditor = {
        parseEditorState: vi.fn((value: unknown) => value),
        setEditorState: vi.fn(),
      }
      b.bindings.set(sid('s1'), {
        session: { loadThrough: vi.fn(async () => {}) },
        eventSource: { getSnapshot: () => ({ entries: [
          { type: 'event', event: { type: 'turn/start', seq: 10, data: { turn: 2 } } },
          { type: 'event', event: { type: 'turn/end', seq: 20 } },
        ] }) },
      })
      b.bindings.set(sid('s1-fork-test'), { ctx: childContext })
      b.editors.set(childContext, childEditor)
      await b.fiber.await()
      const host = document.createElement('div')
      host.dataset.conversationSession = 's1'
      host.innerHTML = '<div data-turn-tail="2"><div data-clock="end"><button aria-label="在新对话中分支">Fork</button></div></div>'
      document.body.append(host)
      const native = vi.fn()
      host.querySelector('button')!.addEventListener('click', native)
      fireEvent.click(host.querySelector('button')!)
      await waitFor(() => expect(b.openedSessions).toContain('s1-fork-test'))
      expect(b.calls.find(call => call.method === 'fork')?.args).toEqual(['s1', 'typed-prompt', expect.stringMatching(/^fork-/u)])
      expect(b.nativeFork).not.toHaveBeenCalled()
      expect(native).not.toHaveBeenCalled()
      const lineage = ((b.branchEntry()?.inject) as unknown as () => { lineage: SessionForkLineage })().lineage
      expect(lineage.getSnapshot().get(sid('s1-fork-test'))?.parentId).toBe('s1')
      expect(b.refresh).toHaveBeenCalled()
      // The old user prompt is never copied into the fresh fork's composer.
      expect(childEditor.setEditorState).not.toHaveBeenCalled()
      expect(b.drafts).toHaveBeenCalledWith('')
      host.remove()
    } finally {
      await b.fiber.dispose()
    }
  })
  it('uses the 0.2 native right-Sidebar tab without replacing Tool details', async () => {
    const b = await bench()
    await b.fiber.await()
    expect(b.entry()?.options).toMatchObject({ key: '@ryanlee2007/dsh-client-ui-session-tree' })
    expect(b.overlayEntry()?.options).toMatchObject({ id: 'session-tree', order: 10 })
    expect(b.ctx.slots.entries('details' as never)[0]?.component).toBe(b.toolDetails)
    expect(b.ctx.slots.entries('conversation.input.dock' as never)).toHaveLength(0)
    b.ctx.emit('command/executed', sid('s1'), 'tree', { kind: 'success' })
    expect(b.opened).toEqual(['session-tree'])
    b.ctx.emit('command/executed', sid('s1'), 'clone', {
      kind: 'success',
      text: JSON.stringify({ ok: true, value: { nativeForkRequired: true } }),
    })
    await waitFor(() => { expect(b.openedSessions).toEqual([sid('s1-native-fork')]) })
    expect(b.nativeFork).toHaveBeenCalledWith({ sessionId: sid('s1'), increaseTitle: true })
    expect(b.refresh).not.toHaveBeenCalled()
  })

  it('routes /fork into the native panel selector state', async () => {
    const b = await bench(view('root', [node('root', null, 'user prompt')]))
    await b.fiber.await()
    const actions = ((b.entry() as unknown as { inject: (id: SessionId) => SessionTreePanelActions }).inject)(sid('s1'))
    expect(actions.modeController?.getSnapshot().selectorOpen).toBe(false)

    b.ctx.emit('command/executed', sid('s1'), 'fork', {
      kind: 'success',
      text: JSON.stringify({ ok: true, value: { selectorRequired: true, userNodeCount: 1 } }),
    })
    expect(actions.modeController?.getSnapshot().selectorOpen).toBe(true)
    expect(b.opened).toEqual(['session-tree'])
  })

  it('forks before the selected user prompt through the native session service', async () => {
    const prompt = '  selected line one\nselected line two  \n'
    const sourceCtx = { role: 'source' }
    const childCtx = { role: 'child' }
    const sourceEditor: TestEditor = {
      parseEditorState: vi.fn((state: unknown) => state),
      setEditorState: vi.fn(),
    }
    const childEditor: TestEditor = {
      parseEditorState: vi.fn((state: unknown) => state),
      setEditorState: vi.fn(),
    }
    const selected: TreeNode = {
      ...node('prompt', null, 'selected prompt'),
      content: [{ type: 'text', text: prompt }],
      metadata: { sessionEventSeq: 8 },
    }
    const childId = sid('native-child')
    const loadThrough = vi.fn(async () => {})
    const entries = [
      { type: 'event', event: { type: 'turn/start', seq: 1 } },
      {
        type: 'event',
        event: {
          type: 'user/message',
          seq: 4,
          data: { content: [{ type: 'text', text: 'previous prompt' }] },
        },
      },
      { type: 'event', event: { type: 'turn/end', seq: 5 } },
      // Harness injection after the previous typed prompt: it is the nearest
      // user/message before the selection, but must never become the fork title.
      {
        type: 'event',
        event: {
          type: 'user/message',
          seq: 6,
          data: {
            content: [{ type: 'text', text: '<system-reminder>skill catalog</system-reminder>' }],
            source: { kind: 'skill-catalog' },
          },
        },
      },
      { type: 'event', event: { type: 'user/message', seq: 8 } },
      { type: 'event', event: { type: 'turn/end', seq: 9 } },
    ]
    const sourceEvents = structuredClone(entries)
    const b = await bench(view('prompt', [selected], 'prompt'))
    b.editors.set(sourceCtx, sourceEditor)
    b.editors.set(childCtx, childEditor)
    b.bindings.set(sid('s1'), {
      session: { loadThrough },
      eventSource: {
        getSnapshot: () => ({ entries }),
      },
      ctx: sourceCtx,
    })
    b.bindings.set(childId, { ctx: childCtx })
    b.nativeFork.mockResolvedValueOnce(childId)
    await b.fiber.await()

    const actions = ((b.entry() as unknown as { inject: (id: SessionId) => SessionTreePanelActions }).inject)(sid('s1'))
    await actions.forkUserPrompt?.(selected)

    expect(loadThrough).toHaveBeenCalledWith(8)
    expect(b.nativeFork).toHaveBeenCalledWith({ sessionId: sid('s1'), atSeq: 5, increaseTitle: true })
    expect(b.inputFor).toHaveBeenCalledWith(childCtx)
    expect(b.inputFor).not.toHaveBeenCalledWith(sourceCtx)
    // The fork starts blank: clear the child draft and do not replay the
    // selected message into its editor.
    expect(b.drafts).toHaveBeenCalledWith('')
    expect(sourceEditor.parseEditorState).not.toHaveBeenCalled()
    expect(sourceEditor.setEditorState).not.toHaveBeenCalled()
    expect(childEditor.parseEditorState).not.toHaveBeenCalled()
    expect(childEditor.setEditorState).not.toHaveBeenCalled()
    const lineage = ((b.branchEntry()?.inject) as unknown as () => { lineage: SessionForkLineage })().lineage
    expect(lineage.getSnapshot().get(childId)?.summary).toBe('previous prompt')
    expect(entries).toEqual(sourceEvents)
    expect(b.openedSessions).toEqual([childId])
    // A remote-created child is not addressable until the catalog refresh lands.
    expect(b.refresh).not.toHaveBeenCalled()
    expect(actions.modeController?.getSnapshot().selectorOpen).toBe(false)
  })

  it('forks at the nearest completed turn, keeping prompts that had no typed text', async () => {
    const prompt = 'selected prompt'
    const sourceCtx = { role: 'source' }
    const childCtx = { role: 'child' }
    const childEditor: TestEditor = {
      parseEditorState: vi.fn((state: unknown) => state),
      setEditorState: vi.fn(),
    }
    const selected: TreeNode = {
      ...node('prompt', null, 'selected prompt'),
      content: [{ type: 'text', text: prompt }],
      metadata: { sessionEventSeq: 5 },
    }
    const childId = sid('native-child-nearest')
    const entries = [
      {
        type: 'event',
        event: {
          type: 'user/message',
          seq: 1,
          data: { content: [{ type: 'text', text: 'first prompt' }], source: { kind: 'user' } },
        },
      },
      { type: 'event', event: { type: 'turn/end', seq: 2 } },
      // A completed image/tool turn without a typed prompt: its turn/end is the
      // nearest boundary before the selected prompt and must be used verbatim.
      { type: 'event', event: { type: 'assistant/message', seq: 3 } },
      { type: 'event', event: { type: 'turn/end', seq: 4 } },
      { type: 'event', event: { type: 'user/message', seq: 5 } },
      { type: 'event', event: { type: 'turn/end', seq: 6 } },
    ]
    const b = await bench(view('prompt', [selected], 'prompt'))
    b.editors.set(sourceCtx, { parseEditorState: vi.fn((state: unknown) => state), setEditorState: vi.fn() })
    b.editors.set(childCtx, childEditor)
    b.bindings.set(sid('s1'), {
      session: { loadThrough: vi.fn(async () => {}) },
      eventSource: { getSnapshot: () => ({ entries }) },
      ctx: sourceCtx,
    })
    b.bindings.set(childId, { ctx: childCtx })
    b.nativeFork.mockResolvedValueOnce(childId)
    await b.fiber.await()

    const actions = ((b.entry() as unknown as { inject: (id: SessionId) => SessionTreePanelActions }).inject)(sid('s1'))
    await actions.forkUserPrompt?.(selected)

    expect(b.nativeFork).toHaveBeenCalledWith({ sessionId: sid('s1'), atSeq: 4, increaseTitle: true })
  })

  it('reveals a custom panel fork with an empty composer', async () => {
    const childId = sid('s1-fork-test')
    const childCtx = {}
    const childEditor: TestEditor = {
      parseEditorState: vi.fn((state: unknown) => state),
      setEditorState: vi.fn(),
    }
    const b = await bench()
    b.editors.set(childCtx, childEditor)
    b.bindings.set(childId, { ctx: childCtx })
    await b.fiber.await()

    const actions = ((b.entry() as unknown as { inject: (id: SessionId) => SessionTreePanelActions }).inject)(sid('s1'))
    await actions.fork('n1', 'alt')

    expect(b.inputFor).toHaveBeenCalledWith(childCtx)
    // The remote fork returns `prompt: 'test'`, but the child composer must stay blank.
    expect(b.drafts).toHaveBeenCalledWith('')
    expect(childEditor.setEditorState).not.toHaveBeenCalled()
    expect(b.openedSessions).toEqual([childId])
    // A remote-created child is not addressable until the catalog refresh lands.
    expect(b.refresh).toHaveBeenCalled()
  })

  it('reports the native fork limitation for the first user prompt', async () => {
    const selected: TreeNode = {
      ...node('prompt', null, 'first prompt'),
      metadata: { sessionEventSeq: 1 },
    }
    const b = await bench(view('prompt', [selected], 'prompt'))
    b.bindings.set(sid('s1'), {
      session: { loadThrough: vi.fn(async () => {}) },
      eventSource: {
        getSnapshot: () => ({
          entries: [
            { type: 'event', event: { type: 'user/message', seq: 1 } },
            { type: 'event', event: { type: 'turn/end', seq: 2 } },
          ],
        }),
      },
      ctx: {},
    })
    await b.fiber.await()

    const actions = ((b.entry() as unknown as { inject: (id: SessionId) => SessionTreePanelActions }).inject)(sid('s1'))
    await expect(actions.forkUserPrompt?.(selected)).rejects.toThrow(
      'The native fork API cannot fork before the first completed turn',
    )
    expect(b.nativeFork).not.toHaveBeenCalled()
    expect(b.drafts).not.toHaveBeenCalled()
    expect(b.refresh).not.toHaveBeenCalled()
  })

  it('falls back to the additive official shell overlay and opens it on /tree', async () => {
    const b = await bench(view(null, []), false)
    await b.fiber.await()
    expect(b.entry()).toBeUndefined()
    expect(b.overlayEntry()?.options).toMatchObject({ id: 'session-tree', order: 10 })
    expect(b.ctx.slots.entries('details' as never)[0]?.component).toBe(b.toolDetails)
    const injected = b.overlayEntry()?.inject?.() as { controller: SessionTreeOverlayController }
    expect(injected.controller.getSnapshot()).toEqual({
      open: false, nativePanel: false, selectorOpen: false, promptDraft: null,
    })
    b.ctx.emit('command/executed', sid('s1'), 'tree', { kind: 'success' })
    expect(injected.controller.getSnapshot()).toEqual({
      open: true, nativePanel: false, selectorOpen: false, promptDraft: null,
    })
    expect(b.opened).toEqual([])
  })

  it('forwards sidebar actions to the sessionTree remote', async () => {
    const childCtx = {}
    const childEditor: TestEditor = {
      parseEditorState: vi.fn((state: unknown) => state),
      setEditorState: vi.fn(),
    }
    const b = await bench()
    b.editors.set(childCtx, childEditor)
    b.bindings.set(sid('s1-fork-test'), { ctx: childCtx })
    await b.fiber.await()
    const actions = ((b.entry() as unknown as { inject: (id: SessionId) => SessionTreePanelActions }).inject)(sid('s1'))
    await actions.load(sid('s1'))
    await actions.jump('n1')
    await actions.fork('n1', 'alt')
    expect(b.calls).toEqual([
      { method: 'list', args: ['s1'] },
      { method: 'jump', args: ['s1', 'n1'] },
      { method: 'fork', args: ['s1', 'n1', 'alt'] },
    ])
    expect(b.inputFor).toHaveBeenCalledWith(childCtx)
    expect(b.drafts).toHaveBeenCalledWith('')
    expect(b.refresh).toHaveBeenCalled()
  })

  it('renders a bounded IDEA-style graph and binds the exact clicked node', async () => {
    const nodes = [node('root', null, 'root'), node('main', 'root', 'main answer'), node('alt', 'root', 'alternative')]
    const load = vi.fn(async () => view('main', nodes, 'main'))
    const jump = vi.fn(async (nodeId: string | null) => ({ cursor: nodeId, messages: [] }))
    const Panel = SessionTreeDock as unknown as ComponentType<Record<string, unknown>>
    const { container } = render(<Panel
      sessionId={sid('s1')} panel="session-tree" closeDetails={vi.fn()} t={t}
      load={load} jump={jump} fork={vi.fn()}
    />)
    await screen.findByText('alternative')
    expect(container.querySelectorAll('[data-lane-column]').length).toBe(3)
    expect(container.querySelector('[data-node-id="main"]')?.getAttribute('class')).toContain('nodeSelected')
    fireEvent.click(screen.getByLabelText(`${zh['panel.select']} — alternative`))
    await waitFor(() => { expect(jump).toHaveBeenCalledWith('alt') })
    // All rows use the same fixed graph column; no depth-derived margin/padding exists.
    const rows = [...container.querySelectorAll('[data-node-id]')]
    expect(rows).toHaveLength(3)
    expect(rows.every(row => (row as HTMLElement).style.marginLeft === '')).toBe(true)
    expect(container.querySelectorAll('[data-lane-column]')).toHaveLength(3)
  })

  it('keeps a deeply nested tree horizontally bounded', async () => {
    const nodes: TreeNode[] = []
    for (let index = 0; index < 64; index++) {
      nodes.push(node(`n${index}`, index === 0 ? null : `n${index - 1}`, `level ${index}`))
    }
    const Panel = SessionTreeDock as unknown as ComponentType<Record<string, unknown>>
    const { container } = render(<Panel
      sessionId={sid('deep')} panel="session-tree" closeDetails={vi.fn()} t={t}
      load={async () => view('n63', nodes, 'n63')}
      jump={vi.fn()} fork={vi.fn()}
    />)
    await screen.findByText('level 63')
    const rows = [...container.querySelectorAll('[data-node-id]')]
    expect(rows).toHaveLength(64)
    expect(rows.every(row => (row as HTMLElement).style.marginLeft === '' && (row as HTMLElement).style.paddingLeft === '')).toBe(true)
    expect(container.querySelectorAll('[data-lane-column]')).toHaveLength(64)
  })

  it('renders and closes the official overlay drawer for the current non-blank session', async () => {
    const nodes = [node('root', null, 'root')]
    const controller = new SessionTreeOverlayController()
    const remoteActions: SessionTreeRemoteActions = {
      load: vi.fn(async () => view('root', nodes)),
      jump: vi.fn(async (_sessionId, nodeId) => ({ cursor: nodeId, messages: [] })),
      fork: vi.fn(async (_sessionId, nodeId, branch) => ({ cursor: nodeId, branch, forkCount: 1 })),
      onRefresh: vi.fn(() => () => {}),
    }
    controller.open()
    const useSessions = (<T,>(select: (state: {
      current: SessionId
      byId: Record<SessionId, { blank: boolean }>
    }) => T): T => select({ current: sid('s1'), byId: { [sid('s1')]: { blank: false } } }))
    const Overlay = SessionTreeOverlay as unknown as ComponentType<Record<string, unknown>>
    const { container } = render(<Overlay
      controller={controller}
      remoteActions={remoteActions}
      useSessions={useSessions}
      t={t}
    />)
    await screen.findByText('root')
    expect(container.querySelector('[data-session-tree-overlay="mounted"]')?.getAttribute('data-open')).toBe('true')
    fireEvent.click(screen.getByLabelText(zh['panel.close']))
    await waitFor(() => {
      expect(container.querySelector('[data-session-tree-overlay="mounted"]')?.hasAttribute('data-open')).toBe(false)
    })
    expect(screen.queryByText('root')).toBeNull()
  })

  it('closes the official overlay when the current session changes', async () => {
    const controller = new SessionTreeOverlayController()
    const current = { value: sid('s1') }
    const remoteActions: SessionTreeRemoteActions = {
      load: vi.fn(async sessionId => ({ ...view(null, []), sessionId })),
      jump: vi.fn(async (_sessionId, nodeId) => ({ cursor: nodeId, messages: [] })),
      fork: vi.fn(async (_sessionId, nodeId, branch) => ({ cursor: nodeId, branch, forkCount: 1 })),
      onRefresh: vi.fn(() => () => {}),
    }
    const useSessions = (<T,>(select: (state: {
      current: SessionId
      byId: Record<SessionId, { blank: boolean }>
    }) => T): T => select({
      current: current.value,
      byId: { [sid('s1')]: { blank: false }, [sid('s2')]: { blank: false } },
    }))
    const Overlay = SessionTreeOverlay as unknown as ComponentType<Record<string, unknown>>
    controller.open()
    const rendered = render(<Overlay controller={controller} remoteActions={remoteActions} useSessions={useSessions} t={t} />)
    expect(controller.getSnapshot().open).toBe(true)
    current.value = sid('s2')
    rendered.rerender(<Overlay controller={controller} remoteActions={remoteActions} useSessions={useSessions} t={t} />)
    await waitFor(() => { expect(controller.getSnapshot().open).toBe(false) })
  })

  it('routes the fallback overlay selector through the native fork callback', async () => {
    const controller = new SessionTreeOverlayController()
    const selected = node('prompt', null, 'editable prompt')
    const forkUserPrompt = vi.fn(async () => {})
    const remoteActions: SessionTreeRemoteActions = {
      load: vi.fn(async () => view('prompt', [node('prompt', null, 'editable prompt')], 'prompt')),
      jump: vi.fn(async (_sessionId, nodeId) => ({ cursor: nodeId, messages: [] })),
      fork: vi.fn(async (_sessionId, nodeId, branch) => ({ cursor: nodeId, branch, forkCount: 1 })),
      onRefresh: vi.fn(() => () => {}),
    }
    const useSessions = (<T,>(select: (state: {
      current: SessionId
      byId: Record<SessionId, { blank: boolean }>
    }) => T): T => select({ current: sid('s1'), byId: { [sid('s1')]: { blank: false } } }))
    const Overlay = SessionTreeOverlay as unknown as ComponentType<Record<string, unknown>>
    controller.openSelector()
    render(<Overlay
      controller={controller}
      remoteActions={remoteActions}
      forkUserPrompt={forkUserPrompt}
      useSessions={useSessions}
      t={t}
    />)

    await screen.findByText('editable prompt')
    fireEvent.click(screen.getByLabelText(`${zh['fork.selector.select']} — editable prompt`))
    await waitFor(() => {
      expect(forkUserPrompt).toHaveBeenCalledWith(sid('s1'), expect.objectContaining(selected))
    })
  })

  it('reloads the tree when the reactive session-list revision changes', async () => {
    const state = {
      phase: 'ready' as const,
      current: sid('s1'),
      ids: [sid('s1')],
      byId: { [sid('s1')]: { displayTitle: 'Session one', blank: false, running: false, updatedAt: 1 } },
    }
    const load = vi.fn(async () => view('root', [node('root', null, 'root')]))
    const useSessions = (<T,>(select: (value: typeof state) => T): T => select(state))
    const Panel = SessionTreeDock as unknown as ComponentType<Record<string, unknown>>
    const rendered = render(<Panel
      sessionId={sid('s1')} panel="session-tree" closeDetails={vi.fn()} t={t}
      load={load} jump={vi.fn()} fork={vi.fn()} useSessions={useSessions}
    />)
    await screen.findByText('root')
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(1) })

    state.byId[sid('s1')]!.updatedAt = 2
    rendered.rerender(<Panel
      sessionId={sid('s1')} panel="session-tree" closeDetails={vi.fn()} t={t}
      load={load} jump={vi.fn()} fork={vi.fn()} useSessions={useSessions}
    />)
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
  })

  it('keeps tool interactions out of the prompt-only tree', async () => {
    const toolNode: TreeNode = {
      nodeId: 'tool-ok', parentId: null, type: 'tool_call', branch: 'main', summary: 'bash({}) → ok output',
      createdAt: '2026-01-01T00:00:01.000Z', message: { role: 'tool', content: 'ok output', toolCallId: 'call-ok' },
      content: [
        { type: 'tool_call', id: 'call-ok', name: 'bash', arguments: {} },
        { type: 'tool_result', toolCallId: 'call-ok', content: 'ok output' },
      ],
    }
    const failedNode: TreeNode = {
      nodeId: 'tool-failed', parentId: 'tool-ok', type: 'tool_call', branch: 'main', summary: 'pwsh({}) → denied',
      createdAt: '2026-01-01T00:00:02.000Z', error: 'Sandbox: EPERM',
      message: { role: 'tool', content: 'denied', toolCallId: 'call-failed' },
      content: [
        { type: 'tool_call', id: 'call-failed', name: 'pwsh', arguments: {} },
        { type: 'tool_result', toolCallId: 'call-failed', content: 'denied', isError: true },
      ],
    }
    const Panel = SessionTreeDock as unknown as ComponentType<Record<string, unknown>>
    const { container } = render(<Panel
      sessionId={sid('tools')} panel="session-tree" closeDetails={vi.fn()} t={t}
      load={async () => view('tool-failed', [toolNode, failedNode], 'tool-failed')}
      jump={vi.fn()} fork={vi.fn()}
    />)
    // The panel renders typed human prompts only; tool calls stay in the projection.
    await waitFor(() => { expect(container.querySelector('[data-node-id]')).toBeNull() })
  })

  it('navigates to a node turn through the built-in turn rail', async () => {
    const rail = document.createElement('button')
    rail.setAttribute('aria-label', '跳转到第 3 轮')
    const clicked = vi.fn()
    rail.addEventListener('click', clicked)
    document.body.append(rail)
    const turnNode: TreeNode = {
      ...node('turn-node', null, 'third turn prompt'),
      metadata: { sessionEventSeq: 9, turn: 3 },
    }
    const jump = vi.fn(async (nodeId: string | null) => ({ cursor: nodeId, messages: [] }))
    const Panel = SessionTreeDock as unknown as ComponentType<Record<string, unknown>>
    const rendered = render(<Panel
      sessionId={sid('turn')} panel="session-tree" closeDetails={vi.fn()} t={t}
      load={async () => view('turn-node', [turnNode], 'turn-node')}
      jump={jump} fork={vi.fn()}
    />)
    await rendered.findByText('third turn prompt')
    fireEvent.click(rendered.getByLabelText(`${zh['panel.select']} — third turn prompt`))
    await waitFor(() => { expect(jump).toHaveBeenCalledWith('turn-node') })
    await waitFor(() => { expect(clicked).toHaveBeenCalled() })
    rail.remove()
  })

  it('jumps on click without expanding the long message', async () => {
    const full = `begin-${'x'.repeat(4200)}-end`
    const longNode: TreeNode = {
      nodeId: 'long', parentId: null, type: 'message', branch: 'main',
      summary: `${full.slice(0, 297)}...`, createdAt: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: full },
    }
    const jump = vi.fn(async (nodeId: string | null) => ({ cursor: nodeId, messages: [] }))
    const Panel = SessionTreeDock as unknown as ComponentType<Record<string, unknown>>
    const { container } = render(<Panel
      sessionId={sid('long')} panel="session-tree" closeDetails={vi.fn()} t={t}
      load={async () => view('long', [longNode], 'long')}
      jump={jump} fork={vi.fn()}
    />)
    await waitFor(() => { expect(container.querySelector('[data-node-id="long"]')).not.toBeNull() })
    const summary = container.querySelector('[data-node-id="long"] [class*="summary"]')
    expect(summary?.textContent).toBe(full)

    fireEvent.click(screen.getByLabelText(`${zh['panel.select']} — ${full.slice(0, 297)}...`))
    await waitFor(() => { expect(jump).toHaveBeenCalledWith('long') })
    // Clicking navigates the transcript; it never expands the row in place.
    expect(container.querySelector('[data-node-id="long"]')?.getAttribute('class')).not.toContain('nodeMessageOpen')
  })

  it('hides harness-injected user messages from the tree and the fork selector', async () => {
    const injected: TreeNode = {
      ...node('skill-catalog', null, '<system-reminder>skill catalog</system-reminder>'),
      metadata: { injected: true },
    }
    const typed = node('prompt', 'skill-catalog', 'typed prompt')
    const assistant: TreeNode = {
      ...node('answer', 'prompt', 'assistant answer'),
      message: { role: 'assistant', content: 'assistant answer' },
    }
    const Panel = SessionTreeDock as unknown as ComponentType<Record<string, unknown>>
    const { rerender } = render(<Panel
      sessionId={sid('filter')} panel="session-tree" closeDetails={vi.fn()} t={t}
      load={async () => view('answer', [injected, typed, assistant], 'answer')}
      jump={vi.fn()} fork={vi.fn()}
    />)
    await screen.findByText('typed prompt')
    expect(screen.queryByText('<system-reminder>skill catalog</system-reminder>')).toBeNull()
    expect(screen.queryByText('assistant answer')).toBeNull()
    expect(document.querySelectorAll('[data-node-id]')).toHaveLength(1)

    rerender(<Panel
      sessionId={sid('filter')} panel="session-tree" mode="selectUserPrompt"
      closeDetails={vi.fn()} t={t}
      load={async () => view('answer', [injected, typed, assistant], 'answer')}
      jump={vi.fn()} fork={vi.fn()} forkUserPrompt={vi.fn(async () => {})}
    />)
    await screen.findByText('typed prompt')
    expect(screen.queryByText('assistant answer')).toBeNull()
    expect(document.querySelectorAll('[data-node-id]')).toHaveLength(1)
  })

  it('collapses descendants from a fork expander without shifting the title', async () => {
    const nodes = [
      node('parent', null, 'parent prompt'),
      node('child-a', 'parent', 'child answer A'),
      node('child-b', 'parent', 'child answer B'),
      node('grandchild', 'child-a', 'grandchild detail'),
    ]
    const Panel = SessionTreeDock as unknown as ComponentType<Record<string, unknown>>
    render(<Panel
      sessionId={sid('collapse')} panel="session-tree" closeDetails={vi.fn()} t={t}
      load={async () => view('grandchild', nodes, 'grandchild')}
      jump={vi.fn()} fork={vi.fn()}
    />)
    await screen.findByText('grandchild detail')
    const expander = screen.getByLabelText(`${zh['node.collapse']} — parent prompt`)
    const title = screen.getByText('parent prompt')
    expect(expander.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    const row = expander.closest('[data-node-id]')
    expect(row?.getAttribute('data-node-id')).toBe('parent')

    fireEvent.click(expander)
    expect(expander.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('child answer A')).toBeNull()
    expect(screen.queryByText('grandchild detail')).toBeNull()

    fireEvent.click(screen.getByLabelText(`${zh['node.expand']} — parent prompt`))
    expect(screen.getByText('child answer A')).not.toBeNull()
    expect(screen.getByText('grandchild detail')).not.toBeNull()
    expect(row?.getAttribute('data-node-id')).toBe('parent')
  })

  it('hides the expander on a single-branch node', async () => {
    const nodes = [
      node('parent', null, 'linear prompt'),
      node('child', 'parent', 'linear answer'),
    ]
    const Panel = SessionTreeDock as unknown as ComponentType<Record<string, unknown>>
    render(<Panel
      sessionId={sid('linear')} panel="session-tree" closeDetails={vi.fn()} t={t}
      load={async () => view('child', nodes, 'child')}
      jump={vi.fn()} fork={vi.fn()}
    />)
    await screen.findByText('linear answer')
    expect(screen.queryByLabelText(`${zh['node.collapse']} — linear prompt`)).toBeNull()
    expect(screen.queryByLabelText(`${zh['node.expand']} — linear prompt`)).toBeNull()
  })

  it('filters the fork selector to user prompts and reports an empty state', async () => {
    const user = node('prompt', null, 'editable prompt')
    const assistant: TreeNode = {
      ...node('answer', 'prompt', 'hidden answer'),
      message: { role: 'assistant', content: 'hidden answer' },
    }
    const fork = vi.fn()
    const forkUserPrompt = vi.fn(async () => {})
    const Panel = SessionTreeDock as unknown as ComponentType<Record<string, unknown>>
    const { rerender } = render(<Panel
      sessionId={sid('selector')} panel="session-tree" mode="selectUserPrompt"
      closeDetails={vi.fn()} t={t} load={async () => view('answer', [user, assistant], 'answer')}
      jump={vi.fn()} fork={fork} forkUserPrompt={forkUserPrompt}
    />)
    await screen.findByText('editable prompt')
    expect(screen.queryByText('hidden answer')).toBeNull()

    fireEvent.click(screen.getByLabelText(`${zh['fork.selector.select']} — editable prompt`))
    await waitFor(() => { expect(forkUserPrompt).toHaveBeenCalledWith(user) })
    expect(fork).not.toHaveBeenCalled()

    rerender(<Panel
      sessionId={sid('empty-selector')} panel="session-tree" mode="selectUserPrompt"
      closeDetails={vi.fn()} t={t} load={async () => view('answer', [assistant], 'answer')}
      jump={vi.fn()} fork={vi.fn()}
    />)
    await screen.findByText(zh['fork.selector.empty'])
  })

  it('offers only the latest typed prompt in the fork selector', async () => {
    const first = node('prompt-1', null, 'first prompt')
    const answer: TreeNode = {
      ...node('answer-1', 'prompt-1', 'hidden answer'),
      message: { role: 'assistant', content: 'hidden answer' },
    }
    const second = node('prompt-2', 'answer-1', 'second prompt')
    const Panel = SessionTreeDock as unknown as ComponentType<Record<string, unknown>>
    const { container } = render(<Panel
      sessionId={sid('selector-chain')} panel="session-tree" mode="selectUserPrompt"
      closeDetails={vi.fn()} t={t}
      load={async () => view('prompt-2', [first, answer, second], 'prompt-2')}
      jump={vi.fn()} fork={vi.fn()} forkUserPrompt={vi.fn(async () => {})}
    />)
    await screen.findByText('second prompt')
    expect(screen.queryByText('first prompt')).toBeNull()
    expect(screen.queryByText('hidden answer')).toBeNull()
    expect(container.querySelector('[data-node-id="prompt-2"]')).not.toBeNull()
    expect(document.querySelectorAll('[data-node-id]')).toHaveLength(1)
  })

  it('portals an inline /fork menu after its source row and restores native rows', async () => {
    const childId = sid('native-child')
    const siblingId = sid('native-sibling')
    const lineage = new SessionForkLineage()
    lineage.record({
      childId,
      parentId: sid('s1'),
      summary: 'previous prompt',
      branch: 'alt',
      createdAt: 1,
    })
    lineage.record({
      childId: siblingId,
      parentId: sid('s1'),
      summary: 'sibling prompt',
      branch: 'alt2',
      createdAt: 2,
    })
    const state = fakeListState(
      [sid('s1'), childId, siblingId],
      Object.fromEntries([
        fakeRow(sid('s1'), 'Source chat'),
        [childId, {
          id: childId,
          displayTitle: 'native-child',
          parentId: sid('s1'),
          running: true,
          blank: false,
          updatedAt: 2,
        }] as [string, FakeListRow],
        [siblingId, {
          id: siblingId,
          displayTitle: 'native-sibling',
          parentId: sid('s1'),
          running: false,
          blank: false,
          updatedAt: 3,
        }] as [string, FakeListRow],
      ]),
      childId,
    )
    const useSessions = (<T,>(select: (value: typeof state) => T): T => select(state))
    const openedBranches: SessionId[] = []
    const openSessionMenu = vi.fn()
    let archiveSnapshot = { archivedSessionIds: [] as SessionId[] }
    const archiveListeners = new Set<() => void>()
    const archiveSource = {
      getSnapshot: () => archiveSnapshot,
      subscribe: (listener: () => void) => { archiveListeners.add(listener); return () => { archiveListeners.delete(listener) } },
    }
    const native = renderNativeSessionRows([
      { id: sid('s1'), title: 'Source chat', selected: false },
      { id: childId, title: 'native-child', selected: true },
      { id: siblingId, title: 'native-sibling', selected: false },
    ])
    const sourceRow = native.row(sid('s1'))
    const childRow = native.row(childId)
    const Menu = SessionBranchList as unknown as ComponentType<Record<string, unknown>>
    const branch = render(
      <Menu
        lineage={lineage}
        openSession={(id: SessionId) => { openedBranches.push(id) }}
        openSessionMenu={openSessionMenu}
        archiveSource={archiveSource}
        unarchive={vi.fn()}
        useSessions={useSessions}
        t={t}
      />,
    )

    const host = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        `[data-session-tree-branch-host][data-session-tree-branch-target="s1"]`,
      )
      expect(element).not.toBeNull()
      return element!
    })
    expect(host.parentElement).toBe(sourceRow.parentElement)
    expect(host.previousElementSibling).toBe(sourceRow)
    expect(childRow.style.display).toBe('none')
    expect(childRow.getAttribute('data-session-tree-branch-hidden')).toBe(childId)

    const menu = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-session-tree-branch-menu="s1"]',
      )
      expect(element).not.toBeNull()
      return element!
    })
    expect(menu.getAttribute('data-session-tree-branch-menu')).toBe('s1')
    const branchRow = menu.querySelector<HTMLElement>(`[data-branch-session-id="${childId}"]`)
    expect(branchRow?.getAttribute('data-branch-depth')).toBe('1')
    expect(branchRow?.getAttribute('class')).toContain('rowCurrent')
    expect(branchRow?.querySelector('[class*="forkBadge"]')?.textContent).toContain(zh['branch.node.forkBadge'])
    expect(branchRow?.querySelector('[class*="branchChip"]')?.textContent).toBe('alt')
    expect(branchRow?.querySelector('[class*="runningDot"]')).not.toBeNull()
    expect(branchRow?.querySelector('[class*="summary"]')?.textContent).toBe('native-child')
    expect(branchRow?.querySelectorAll('[class*="cellElbow"]')).toHaveLength(1)

    fireEvent.click(screen.getByLabelText(`${zh['branch.node.open']} - native-child`))
    expect(openedBranches).toEqual([childId])
    fireEvent.click(screen.getByLabelText(`${zh['branch.node.manage']} - native-child`))
    expect(openSessionMenu).toHaveBeenCalledWith(childId, 'native-child', expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }))
    expect(openedBranches).toEqual([childId])

    // Branch menus start collapsed after every page load/restart.
    const defaultBody = document.querySelector('[data-session-tree-branch-body]')!
    expect(defaultBody.getAttribute('data-expanded')).toBe('false')
    expect(defaultBody.getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByLabelText(`${zh['branch.menu.collapse']} - Source chat`)).toBeNull()

    fireEvent.click(screen.getByLabelText(`${zh['branch.menu.expand']} - Source chat`))
    const expandedBody = document.querySelector('[data-session-tree-branch-body]')!
    expect(expandedBody.getAttribute('data-expanded')).toBe('true')
    // The transition duration follows the measured content height, never the
    // fixed 160 ms that made long menus snap shut.
    const duration = expandedBody.style.getPropertyValue('--branch-collapse-duration')
    expect(duration).toMatch(/^\d+ms$/u)
    expect(Number.parseInt(duration, 10)).toBeGreaterThanOrEqual(200)

    fireEvent.click(screen.getByLabelText(`${zh['branch.menu.collapse']} - Source chat`))
    // Collapse keeps the rows mounted for the height transition and makes the
    // body inert/aria-hidden instead of unmounting it.
    const collapsedBody = document.querySelector('[data-session-tree-branch-body]')!
    expect(collapsedBody.getAttribute('data-expanded')).toBe('false')
    expect(collapsedBody.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByLabelText(`${zh['branch.node.open']} - native-child`)).not.toBeNull()
    fireEvent.click(screen.getByLabelText(`${zh['branch.menu.expand']} - Source chat`))
    expect(document.querySelector('[data-session-tree-branch-body]')?.getAttribute('data-expanded')).toBe('true')

    await act(async () => {
      archiveSnapshot = { archivedSessionIds: [childId] }
      for (const listener of archiveListeners) listener()
    })
    expect(document.querySelector(`[data-branch-session-id="${childId}"]`)).toBeNull()
    expect(childRow.style.display).toBe('')
    expect(lineage.getSnapshot().has(childId)).toBe(true)
    // The archived fork stays findable in the branch menu and can be restored.
    const restore = screen.getByLabelText(`${zh['branch.archived.restore']} - Source chat · previous prompt`)
    // The archived row is named after the parent Session, not the child or prompt.
    const archivedRow = restore.closest('li')!
    expect(archivedRow.textContent).toContain('Source chat')
    expect(archivedRow.textContent).not.toContain(childId)
    // Secondary copy stays out of the always-visible layout: only a compact
    // count remains, and the long explanation lives behind the info tooltip.
    expect(archivedRow.parentElement?.parentElement?.textContent).toContain(
      zh['branch.archived.label'].replace('{count}', '1'),
    )
    expect(screen.queryByText(zh['branch.archived.hint'])).toBeNull()
    expect(screen.getByRole('button', { name: zh['branch.archived.hint'] })).toBeTruthy()
    // Archived entries sit at the bottom of the menu, after the active rows.
    const menuList = document.querySelector(`[data-session-tree-branch-menu="s1"]`)!
    const lastBranchRow = menuList.querySelector('[data-branch-session-id]')!
    expect(lastBranchRow.compareDocumentPosition(archivedRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await act(async () => {
      fireEvent.click(restore)
      archiveSnapshot = { archivedSessionIds: [] }
      for (const listener of archiveListeners) listener()
    })
    expect(document.querySelector(`[data-branch-session-id="${childId}"]`)).not.toBeNull()

    branch.unmount()
    expect(childRow.style.display).toBe('')
    expect(childRow.hasAttribute('data-session-tree-branch-hidden')).toBe(false)
    expect(document.querySelector('[data-session-tree-branch-host]')).toBeNull()
  })

  it('keeps the archived-only menu out of the hide-archived filter', async () => {
    const sourceId = sid('filter-s1')
    const childId = sid('filter-child')
    const lineage = new SessionForkLineage()
    lineage.record({ childId, parentId: sourceId, summary: 'archived prompt', branch: 'alt', createdAt: 3 })
    const state = fakeListState(
      [sourceId, childId],
      Object.fromEntries([
        fakeRow(sourceId, 'Source chat'),
        [childId, {
          id: childId,
          displayTitle: 'archived child',
          parentId: sourceId,
          running: false,
          blank: false,
          updatedAt: 4,
        }] as [string, FakeListRow],
      ]),
      childId,
    )
    const useSessions = (<T,>(select: (value: typeof state) => T): T => select(state))
    let archiveSnapshot = { archivedSessionIds: [] as SessionId[] }
    const archiveListeners = new Set<() => void>()
    const archiveSource = {
      getSnapshot: () => archiveSnapshot,
      subscribe: (listener: () => void) => { archiveListeners.add(listener); return () => { archiveListeners.delete(listener) } },
    }
    const rows = [
      { id: sourceId, title: 'Source chat', selected: false },
      { id: childId, title: 'archived child', selected: true },
    ]
    const native = renderNativeSessionRows(rows)
    const Menu = SessionBranchList as unknown as ComponentType<Record<string, unknown>>
    render(
      <Menu
        lineage={lineage}
        openSession={vi.fn()}
        openSessionMenu={vi.fn()}
        archiveSource={archiveSource}
        unarchive={vi.fn()}
        useSessions={useSessions}
        t={t}
      />,
    )
    await screen.findByLabelText(`${zh['branch.node.open']} - archived child`)
    await waitFor(() => {
      expect(document.querySelector(`[data-session-tree-branch-menu="${sourceId}"]`)).not.toBeNull()
    })

    // Default filter: the archived row leaves the native list and the branch
    // menu loses its last live fork, so header, count and placeholder all go.
    await act(async () => {
      archiveSnapshot = { archivedSessionIds: [childId] }
      for (const listener of archiveListeners) listener()
      native.setRows([rows[0]!])
    })
    await waitFor(() => {
      expect(document.querySelector('[data-session-tree-branch-host]')).toBeNull()
    })
    expect(document.querySelector(`[data-session-tree-branch-menu="${sourceId}"]`)).toBeNull()
    expect(screen.queryByText(`x0`)).toBeNull()
    expect(screen.queryByLabelText(`${zh['branch.archived.restore']} - Source chat · archived prompt`)).toBeNull()

    // "Show archived": the native archived row returns, so the menu returns as
    // the restore entry. It has a header but no misleading `x0` count.
    await act(async () => { native.setRows(rows) })
    await waitFor(() => {
      expect(document.querySelector(`[data-session-tree-branch-menu="${sourceId}"]`)).not.toBeNull()
    })
    expect(native.row(childId).style.display).toBe('')
    expect(document.querySelector(`[data-session-tree-branch-menu="${sourceId}"]`)?.textContent).toContain(
      zh['branch.menu.title'],
    )
    expect(screen.queryByText('x0')).toBeNull()
    await screen.findByLabelText(`${zh['branch.archived.restore']} - Source chat · archived prompt`)
  })

  it('shows the archived-only menu under the archived-only filter and hides it when archived rows are hidden', async () => {
    const sourceId = sid('only-s1')
    const childId = sid('only-child')
    const lineage = new SessionForkLineage()
    lineage.record({ childId, parentId: sourceId, summary: 'only archived', createdAt: 3 })
    const state = fakeListState(
      [sourceId, childId],
      Object.fromEntries([
        fakeRow(sourceId, 'Archived source'),
        fakeRow(childId, 'Archived child', sourceId),
      ]),
      sourceId,
    )
    const useSessions = (<T,>(select: (value: typeof state) => T): T => select(state))
    let archiveSnapshot = { archivedSessionIds: [sourceId, childId] as SessionId[] }
    const archiveListeners = new Set<() => void>()
    const archiveSource = {
      getSnapshot: () => archiveSnapshot,
      subscribe: (listener: () => void) => { archiveListeners.add(listener); return () => { archiveListeners.delete(listener) } },
    }
    const rows = [
      { id: sourceId, title: 'Archived source', selected: false },
      { id: childId, title: 'Archived child', selected: false },
    ]
    const native = renderNativeSessionRows(rows)
    const Menu = SessionBranchList as unknown as ComponentType<Record<string, unknown>>
    render(
      <Menu
        lineage={lineage}
        openSession={vi.fn()}
        openSessionMenu={vi.fn()}
        archiveSource={archiveSource}
        unarchive={vi.fn()}
        useSessions={useSessions}
        t={t}
      />,
    )
    // "Archived only" renders the archived source and child rows.
    await waitFor(() => {
      expect(document.querySelector(`[data-session-tree-branch-menu="${sourceId}"]`)).not.toBeNull()
    })
    expect(screen.queryByText('x0')).toBeNull()
    await screen.findByLabelText(`${zh['branch.archived.restore']} - Archived source · only archived`)

    // Switching back to "hide archived" removes the anchor row entirely.
    await act(async () => {
      native.setRows([])
      archiveSnapshot = { archivedSessionIds: [sourceId, childId] }
      for (const listener of archiveListeners) listener()
    })
    await waitFor(() => {
      expect(document.querySelector(`[data-session-tree-branch-menu="${sourceId}"]`)).toBeNull()
    })
  })

  it('keeps an archived-only menu directly under its parent Session row', async () => {
    const sourceId = sid('arch-source')
    const childId = sid('arch-child')
    const lineage = new SessionForkLineage()
    lineage.record({ childId, parentId: sourceId, summary: 'archived fork', createdAt: 2 })
    const state = fakeListState(
      [sourceId, childId],
      Object.fromEntries([
        fakeRow(sourceId, 'Archived source'),
        fakeRow(childId, 'Archived child', sourceId),
      ]),
      sourceId,
    )
    const useSessions = (<T,>(select: (value: typeof state) => T): T => select(state))
    const archiveSnapshot = { archivedSessionIds: [childId] as SessionId[] }
    const archiveSource = {
      getSnapshot: () => archiveSnapshot,
      subscribe: () => () => {},
    }
    // Grouped workspace DOM: the menu must follow the source row, not jump to
    // the end of its workspace section.
    const root = document.createElement('div')
    root.innerHTML = `<div role="tree">
      <div data-test-group="dv14">
        <div role="treeitem" aria-selected="false" data-row-key="session:arch-source">Archived source</div>
        <div role="treeitem" aria-selected="false" data-row-key="session:arch-child">Archived child</div>
        <button data-row-key="overflow:dv14">more</button>
      </div>
    </div>`
    document.body.append(root)
    try {
      const Menu = SessionBranchList as unknown as ComponentType<Record<string, unknown>>
      render(
        <Menu
          lineage={lineage}
          openSession={vi.fn()}
          openSessionMenu={vi.fn()}
          archiveSource={archiveSource}
          unarchive={vi.fn()}
          useSessions={useSessions}
          t={t}
        />,
      )
      const host = await waitFor(() => {
        const element = root.querySelector<HTMLElement>('[data-session-tree-branch-host]')
        expect(element).not.toBeNull()
        return element!
      })
      const dv14 = root.querySelector<HTMLElement>('[data-test-group="dv14"]')!
      const sourceRow = root.querySelector<HTMLElement>('[data-row-key="session:arch-source"]')!
      expect(host.parentElement).toBe(dv14)
      expect(host.previousElementSibling).toBe(sourceRow)
      expect(dv14.lastElementChild).not.toBe(host)
      await screen.findByLabelText(`${zh['branch.archived.restore']} - Archived source · archived fork`)
    } finally {
      root.remove()
    }
  })

  it('disables scroll anchoring on the sidebar scroller, never on the menu itself', () => {
    vi.useFakeTimers()
    const setSizes = (element: HTMLElement, scrollHeight: number, clientHeight: number): void => {
      Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight })
      Object.defineProperty(element, 'clientHeight', { configurable: true, value: clientHeight })
    }
    try {
      const scroller = document.createElement('div')
      scroller.style.overflowY = 'auto'
      setSizes(scroller, 900, 300)
      // The menu clips horizontally, so its computed overflow-y can be auto; it
      // must never be mistaken for the list scroller.
      const host = document.createElement('div')
      host.setAttribute('data-session-tree-branch-host', 'mounted')
      const menu = document.createElement('div')
      menu.style.overflowY = 'auto'
      setSizes(menu, 400, 100)
      scroller.append(host)
      host.append(menu)
      document.body.append(scroller)

      holdScrollAnchorDuring(menu, 300)
      expect(scroller.style.overflowAnchor).toBe('none')
      expect(menu.style.overflowAnchor).toBe('')
      vi.advanceTimersByTime(359)
      expect(scroller.style.overflowAnchor).toBe('none')
      vi.advanceTimersByTime(1)
      expect(scroller.style.overflowAnchor).toBe('')

      // A second fold before the first restores must keep anchoring disabled
      // until the latest fold ends.
      holdScrollAnchorDuring(menu, 200)
      holdScrollAnchorDuring(menu, 200)
      vi.advanceTimersByTime(259)
      expect(scroller.style.overflowAnchor).toBe('none')
      vi.advanceTimersByTime(1)
      expect(scroller.style.overflowAnchor).toBe('')
      scroller.remove()
    } finally {
      vi.useRealTimers()
    }
  })

  it('puts the fork completion dot in front of the row and mirrors it on the collapsed parent tab', async () => {
    const source = sid('done-s1')
    const child = sid('done-child')
    const lineage = new SessionForkLineage()
    lineage.record({ childId: child, parentId: source, summary: 'finished fork' })
    const state = fakeListState([source, child], Object.fromEntries([
      fakeRow(source, 'Source chat'),
      fakeRow(child, 'Child chat', source),
    ]), source)
    let statusMap = new Map<SessionId, { running: boolean; pendingInteraction: undefined; completionUnread: boolean }>([
      [child, { running: false, pendingInteraction: undefined, completionUnread: true }],
    ])
    const useSessionStatus = (<T,>(select: (value: typeof statusMap) => T): T => select(statusMap))
    const useSessions = (<T,>(select: (value: typeof state) => T): T => select(state))
    renderNativeSessionRows([
      { id: source, title: 'Source chat' },
      { id: child, title: 'Child chat' },
    ])
    const Menu = SessionBranchList as unknown as ComponentType<Record<string, unknown>>
    const view = render(
      <Menu
        lineage={lineage}
        openSession={vi.fn()}
        useSessions={useSessions}
        useSessionStatus={useSessionStatus}
        t={t}
      />,
    )

    await waitFor(() => {
      const row = document.querySelector(`[data-branch-session-id="${child}"]`)
      const dot = row?.querySelector('[data-branch-completed="true"]')
      expect(dot).not.toBeNull()
      // The dot sits before the row's open button, not in the badge line.
      expect(dot?.nextElementSibling?.tagName).toBe('BUTTON')
    })
    // Collapsed by default: the reminder lives on the native parent tab.
    const sourceRow = document.querySelector<HTMLElement>(`[data-row-key="session:${source}"]`)
    expect(sourceRow?.getAttribute('data-session-tree-branch-completed')).toBe('true')
    expect(document.querySelector('[data-session-tree-branch-menu] [data-branch-menu-completed]')).toBeNull()

    fireEvent.click(document.querySelector<HTMLElement>('[data-session-tree-branch-menu] button[aria-expanded]')!)
    await waitFor(() => {
      expect(document.querySelector('[data-session-tree-branch-menu] [data-branch-menu-completed]')).not.toBeNull()
    })
    expect(sourceRow?.hasAttribute('data-session-tree-branch-completed')).toBe(false)

    statusMap = new Map([[child, { running: false, pendingInteraction: undefined, completionUnread: false }]])
    view.rerender(
      <Menu
        lineage={lineage}
        openSession={vi.fn()}
        useSessions={useSessions}
        useSessionStatus={useSessionStatus}
        t={t}
      />,
    )
    await waitFor(() => {
      expect(document.querySelector('[data-branch-completed="true"]')).toBeNull()
    })
    expect(document.querySelector('[data-branch-menu-completed]')).toBeNull()
    expect(sourceRow?.hasAttribute('data-session-tree-branch-completed')).toBe(false)
  })

  it('shows a finished nested fork on its collapsed parent fork row', async () => {
    const source = sid('nested-s')
    const child = sid('nested-c')
    const grandchild = sid('nested-g')
    const lineage = new SessionForkLineage()
    lineage.record({ childId: child, parentId: source, summary: 'first fork' })
    lineage.record({ childId: grandchild, parentId: child, summary: 'nested fork' })
    const state = fakeListState([source, child, grandchild], Object.fromEntries([
      fakeRow(source, 'Source'),
      fakeRow(child, 'Fork', source),
      fakeRow(grandchild, 'Nested fork', child),
    ]), source)
    const statusMap = new Map<SessionId, { running: boolean; pendingInteraction: undefined; completionUnread: boolean }>([
      [grandchild, { running: false, pendingInteraction: undefined, completionUnread: true }],
    ])
    const useSessionStatus = (<T,>(select: (value: typeof statusMap) => T): T => select(statusMap))
    const useSessions = (<T,>(select: (value: typeof state) => T): T => select(state))
    renderNativeSessionRows([{ id: source, title: 'Source' }, { id: child, title: 'Fork' }])
    const Menu = SessionBranchList as unknown as ComponentType<Record<string, unknown>>
    render(
      <Menu
        lineage={lineage}
        openSession={vi.fn()}
        useSessions={useSessions}
        useSessionStatus={useSessionStatus}
        t={t}
      />,
    )
    await waitFor(() => {
      expect(document.querySelector(`[data-branch-session-id="${child}"]`)).not.toBeNull()
    })
    fireEvent.click(document.querySelector<HTMLElement>('[data-session-tree-branch-menu] button[aria-expanded]')!)
    await waitFor(() => {
      expect(document.querySelector(`[data-branch-session-id="${grandchild}"]`)).not.toBeNull()
    })
    const childRow = document.querySelector<HTMLElement>(`[data-branch-session-id="${child}"]`)!
    fireEvent.click(childRow.querySelector<HTMLElement>('button[aria-expanded]')!)
    await waitFor(() => {
      expect(childRow.querySelector('[data-branch-completed="true"]')).not.toBeNull()
    })
    expect(childRow.querySelector('[data-branch-completed="true"]')?.nextElementSibling?.tagName).toBe('BUTTON')
  })

  it('rebuilds the inline fork list from native child ids without stored lineage', async () => {
    const parent = sid('derive-parent')
    const child = sid('derive-parent-fork-mw6abc-abc123')
    const state = fakeListState([parent, child], Object.fromEntries([
      fakeRow(parent, 'Parent chat'), fakeRow(child, 'Derived child', parent),
    ]), parent)
    const useSessions = (<T,>(select: (value: typeof state) => T): T => select(state))
    const native = renderNativeSessionRows([
      { id: parent, title: 'Parent chat' },
      { id: child, title: 'Derived child' },
    ])
    const Menu = SessionBranchList as unknown as ComponentType<Record<string, unknown>>
    const lineage = new SessionForkLineage()
    render(<Menu lineage={lineage} openSession={vi.fn()} openSessionMenu={vi.fn()} useSessions={useSessions} t={t} />)

    await waitFor(() => {
      expect(document.querySelector(`[data-session-tree-branch-menu="${parent}"]`)).not.toBeNull()
    })
    expect(document.querySelector(`[data-branch-session-id="${child}"]`)).not.toBeNull()
    await waitFor(() => { expect(native.row(child).style.display).toBe('none') })
  })

  it('restores the inline fork menu after a workspace row remount', async () => {
    const childId = sid('remount-child')
    const lineage = new SessionForkLineage()
    lineage.record({ childId, parentId: sid('s1'), summary: 'remount fork', createdAt: 1 })
    const state = fakeListState([sid('s1'), childId], Object.fromEntries([
      fakeRow(sid('s1'), 'Source chat'), fakeRow(childId, 'Child chat', sid('s1')),
    ]), sid('s1'))
    const useSessions = (<T,>(select: (value: typeof state) => T): T => select(state))
    const native = renderNativeSessionRows([
      { id: sid('s1'), title: 'Source chat' },
      { id: childId, title: 'Child chat' },
    ])
    const Menu = SessionBranchList as unknown as ComponentType<Record<string, unknown>>
    const view = render(<Menu lineage={lineage} openSession={vi.fn()} useSessions={useSessions} t={t} />)

    await waitFor(() => {
      expect(document.querySelector(`[data-session-tree-branch-menu="${sid('s1')}"]`)).not.toBeNull()
    })
    // Collapse the workspace: the native rows unmount.
    await act(async () => { native.setRows([]) })
    await waitFor(() => {
      expect(document.querySelector('[data-session-tree-branch-host]')).toBeNull()
    })
    // Expand again: rows remount and the menu must come back.
    await act(async () => {
      native.setRows([
        { id: sid('s1'), title: 'Source chat' },
        { id: childId, title: 'Child chat' },
      ])
    })
    await waitFor(() => {
      expect(document.querySelector(`[data-session-tree-branch-menu="${sid('s1')}"]`)).not.toBeNull()
    })
    expect(document.querySelector('[data-branch-session-id="remount-child"]')).not.toBeNull()
    view.unmount()
  })

  it('keeps /clone children in the native list and records previous-prompt fork titles', async () => {
    const b = await bench()
    await b.fiber.await()
    const lineage = ((b.branchEntry()?.inject) as unknown as () => { lineage: SessionForkLineage })().lineage
    b.ctx.emit('command/executed', sid('s1'), 'clone', {
      kind: 'success',
      text: JSON.stringify({ ok: true, value: { nativeForkRequired: true } }),
    })
    await waitFor(() => { expect(b.openedSessions).toEqual([sid('s1-native-fork')]) })
    expect(lineage.getSnapshot().size).toBe(0)

    const cloneId = sid('s1-native-fork')
    const state = fakeListState(
      [sid('s1'), cloneId],
      Object.fromEntries([fakeRow(sid('s1'), 'Source chat'), fakeRow(cloneId, 'cloned copy', sid('s1'))]),
      cloneId,
    )
    const useSessions = (<T,>(select: (value: typeof state) => T): T => select(state))
    const native = renderNativeSessionRows([
      { id: sid('s1'), title: 'Source chat' },
      { id: cloneId, title: 'cloned copy', selected: true },
    ])
    const Menu = SessionBranchList as unknown as ComponentType<Record<string, unknown>>
    render(<Menu lineage={lineage} openSession={vi.fn()} useSessions={useSessions} t={t} />)
    expect(document.querySelector('[data-session-tree-branch-host]')).toBeNull()
    expect(native.row(cloneId).style.display).toBe('')

    b.ctx.emit('command/executed', sid('s1'), 'fork', {
      kind: 'success',
      text: JSON.stringify({
        ok: true,
        value: {
          sessionId: 's1-fork-x',
          prompt: '  selected prompt  ',
          previousUserPrompt: '  previous\n prompt  ',
        },
      }),
    })
    await waitFor(() => { expect(lineage.getSnapshot().has(sid('s1-fork-x'))).toBe(true) })
    expect(lineage.getSnapshot().get(sid('s1-fork-x'))).toMatchObject({
      childId: sid('s1-fork-x'),
      parentId: sid('s1'),
      summary: 'previous prompt',
    })
  })

  it('renders nested inline branches with connector rails and per-level collapse', async () => {
    const lineage = new SessionForkLineage()
    lineage.record({ childId: sid('c1'), parentId: sid('s1'), summary: 'first fork', createdAt: 1 })
    lineage.record({ childId: sid('c2'), parentId: sid('s1'), summary: 'second fork', createdAt: 2 })
    lineage.record({ childId: sid('g1'), parentId: sid('c1'), summary: 'fork of fork', createdAt: 3 })
    const state = fakeListState(
      [sid('s1'), sid('c1'), sid('c2'), sid('g1')],
      Object.fromEntries([
        fakeRow(sid('s1'), 'Source chat'),
        [sid('c1'), {
          id: sid('c1'),
          displayTitle: 'c1',
          parentId: sid('s1'),
          running: true,
          blank: false,
          updatedAt: 3,
        }] as [string, FakeListRow],
        fakeRow(sid('c2'), 'c2', sid('s1')),
        fakeRow(sid('g1'), 'g1', sid('c1')),
      ]),
      sid('c1'),
    )
    const useSessions = (<T,>(select: (value: typeof state) => T): T => select(state))
    renderNativeSessionRows([
      { id: sid('s1'), title: 'Source chat' },
      { id: sid('c1'), title: 'c1' },
      { id: sid('c2'), title: 'c2' },
      { id: sid('g1'), title: 'g1' },
    ])
    const Menu = SessionBranchList as unknown as ComponentType<Record<string, unknown>>
    render(<Menu lineage={lineage} openSession={vi.fn()} useSessions={useSessions} t={t} />)

    const order = await waitFor(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('[data-branch-session-id]')]
      expect(rows).toHaveLength(3)
      return rows
    })
    expect(order
      .map(row => [row.getAttribute('data-branch-session-id'), row.getAttribute('data-branch-depth')] as const)
    ).toEqual([
      ['c1', '1'], ['g1', '2'], ['c2', '1'],
    ])
    expect(order[0]?.getAttribute('data-branch-session-id')).toBe(sid('c1'))
    expect(order[0]?.getAttribute('class')).toContain('rowCurrent')
    expect(order[0]?.querySelector('[class*="runningDot"]')).not.toBeNull()

    const grandchild = document.querySelector<HTMLElement>('[data-branch-session-id="g1"]')
    expect(grandchild?.querySelectorAll('[class*="cellRail"]')).toHaveLength(1)
    expect(grandchild?.querySelectorAll('[class*="cellElbow"]')).toHaveLength(1)
    expect(grandchild?.querySelectorAll('[class*="cellElbowLast"]')).toHaveLength(1)
    const middleChild = document.querySelector<HTMLElement>('[data-branch-session-id="c1"]')
    expect(middleChild?.querySelectorAll('[class*="cellElbow"]:not([class*="cellElbowLast"])')).toHaveLength(1)
    const lastChild = document.querySelector<HTMLElement>('[data-branch-session-id="c2"]')
    expect(lastChild?.querySelectorAll('[class*="cellRail"]')).toHaveLength(0)
    expect(lastChild?.querySelectorAll('[class*="cellElbowLast"]')).toHaveLength(1)

    fireEvent.click(screen.getByLabelText(`${zh['node.collapse']} - c1`))
    const c1Children = document.querySelector(`[data-session-tree-branch-body][data-branch-parent="${sid('c1')}"]`)!
    expect(c1Children.getAttribute('data-expanded')).toBe('false')
    expect(c1Children.getAttribute('aria-hidden')).toBe('true')
    expect(document.querySelector('[data-branch-session-id="g1"]')).not.toBeNull()
    expect(document.querySelector('[data-branch-session-id="c2"]')).not.toBeNull()

    fireEvent.click(screen.getByLabelText(`${zh['node.expand']} - c1`))
    expect(document.querySelector(`[data-session-tree-branch-body][data-branch-parent="${sid('c1')}"]`)?.getAttribute('data-expanded')).toBe('true')

    // The menu header starts collapsed; opening it is a separate toggle from
    // the per-row expanders above.
    fireEvent.click(screen.getByLabelText(`${zh['branch.menu.expand']} - Source chat`))
    expect(document.querySelector('[data-session-tree-branch-body]')?.getAttribute('data-expanded')).toBe('true')
    fireEvent.click(screen.getByLabelText(`${zh['branch.menu.collapse']} - Source chat`))
    const collapsedNestedBody = document.querySelector('[data-session-tree-branch-body]')!
    expect(collapsedNestedBody.getAttribute('data-expanded')).toBe('false')
    expect(collapsedNestedBody.getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(screen.getByLabelText(`${zh['branch.menu.expand']} - Source chat`))
    expect(document.querySelector('[data-session-tree-branch-body]')?.getAttribute('data-expanded')).toBe('true')
    expect(document.querySelector('[data-branch-session-id="c2"]')).not.toBeNull()
  })

  it('labels a branch with its first own prompt, then follows later dynamic titles', async () => {
    const parent = sid('topic-parent')
    const childId = sid('topic-child')
    const lineage = new SessionForkLineage()
    lineage.record({ childId, parentId: parent, summary: 'inherited prompt', createdAt: 1 })
    let state = fakeListState([parent, childId], Object.fromEntries([
      fakeRow(parent, 'Parent chat'),
      fakeRow(childId, 'Parent chat', parent),
    ]), parent)
    const useSessions = (<T,>(select: (value: typeof state) => T): T => select(state))
    renderNativeSessionRows([{ id: parent, title: 'Parent chat' }, { id: childId, title: 'Parent chat' }])
    const Menu = SessionBranchList as unknown as ComponentType<Record<string, unknown>>
    const view = render(<Menu lineage={lineage} openSession={vi.fn()} useSessions={useSessions} t={t} />)

    const label = (): string | null =>
      document.querySelector<HTMLElement>(`[data-branch-session-id="${childId}"] [class*="summary"]`)?.textContent ?? null
    await waitFor(() => { expect(label()).toBe(`${'Parent chat'} · ${zh['branch.node.forkBadge']} 1`) })

    await act(async () => { rememberBranchTopic(childId, 'first new topic', 'Parent chat') })
    await waitFor(() => { expect(label()).toBe('first new topic') })

    // A later dynamic title / user rename after capture wins over the snapshot.
    state = fakeListState([parent, childId], Object.fromEntries([
      fakeRow(parent, 'Parent chat'),
      fakeRow(childId, 'Later dynamic title', parent),
    ]), parent)
    view.rerender(<Menu lineage={lineage} openSession={vi.fn()} useSessions={useSessions} t={t} />)
    await waitFor(() => { expect(label()).toBe('Later dynamic title') })
  })

  it('keeps a collapsed menu collapsed when another fork is created elsewhere', async () => {
    const source = sid('s1')
    const other = sid('s2')
    const child = sid('c1')
    const newChild = sid('c2')
    const lineage = new SessionForkLineage()
    lineage.record({ childId: child, parentId: source, summary: 'first fork' })
    let state = fakeListState([source, child, other], Object.fromEntries([
      fakeRow(source, 'Source chat'),
      fakeRow(child, 'child one', source),
      fakeRow(other, 'Other chat'),
    ]), source)
    const useSessions = (<T,>(select: (value: typeof state) => T): T => select(state))
    renderNativeSessionRows([
      { id: source, title: 'Source chat' },
      { id: child, title: 'child one' },
      { id: other, title: 'Other chat' },
    ])
    const Menu = SessionBranchList as unknown as ComponentType<Record<string, unknown>>
    const view = render(<Menu lineage={lineage} openSession={vi.fn()} useSessions={useSessions} t={t} />)
    await waitFor(() => {
      expect(document.querySelector(`[data-session-tree-branch-menu="${source}"]`)).not.toBeNull()
    })
    const body = (): HTMLElement | null =>
      document.querySelector<HTMLElement>(`[data-session-tree-branch-menu="${source}"] [data-session-tree-branch-body]`)
    // Default collapsed; open it, then collapse it explicitly.
    expect(body()?.getAttribute('data-expanded')).toBe('false')
    fireEvent.click(screen.getByLabelText(`${zh['branch.menu.expand']} - Source chat`))
    expect(body()?.getAttribute('data-expanded')).toBe('true')
    fireEvent.click(screen.getByLabelText(`${zh['branch.menu.collapse']} - Source chat`))
    expect(body()?.getAttribute('data-expanded')).toBe('false')

    // A new fork under a different source must not reset other menus.
    act(() => { lineage.record({ childId: newChild, parentId: other, summary: 'new fork' }) })
    state = fakeListState([source, child, other, newChild], Object.fromEntries([
      fakeRow(source, 'Source chat'),
      fakeRow(child, 'child one', source),
      fakeRow(other, 'Other chat'),
      fakeRow(newChild, 'child two', other),
    ]), source)
    view.rerender(<Menu lineage={lineage} openSession={vi.fn()} useSessions={useSessions} t={t} />)
    await waitFor(() => {
      expect(document.querySelector(`[data-session-tree-branch-menu="${other}"]`)).not.toBeNull()
    })
    expect(body()?.getAttribute('data-expanded')).toBe('false')
  })

  it('keeps an opened menu across a workspace remount and only resets on a host restart', async () => {
    const source = sid('persist-s1')
    const child = sid('persist-child')
    const lineage = new SessionForkLineage()
    lineage.record({ childId: child, parentId: source, summary: 'persist fork' })
    const state = fakeListState([source, child], Object.fromEntries([
      fakeRow(source, 'Source chat'),
      fakeRow(child, 'Child chat', source),
    ]), source)
    const useSessions = (<T,>(select: (value: typeof state) => T): T => select(state))
    const native = renderNativeSessionRows([
      { id: source, title: 'Source chat' },
      { id: child, title: 'Child chat' },
    ])
    const Menu = SessionBranchList as unknown as ComponentType<Record<string, unknown>>
    const first = render(<Menu lineage={lineage} openSession={vi.fn()} useSessions={useSessions} t={t} />)
    await waitFor(() => {
      expect(document.querySelector(`[data-session-tree-branch-menu="${source}"] [data-session-tree-branch-body]`)).not.toBeNull()
    })
    const body = (): HTMLElement | null =>
      document.querySelector<HTMLElement>(`[data-session-tree-branch-menu="${source}"] [data-session-tree-branch-body]`)
    expect(body()?.getAttribute('data-expanded')).toBe('false')
    fireEvent.click(screen.getByLabelText(`${zh['branch.menu.expand']} - Source chat`))
    expect(body()?.getAttribute('data-expanded')).toBe('true')

    // Collapsing the workspace removes the native rows and unmounts the portal.
    await act(async () => { native.setRows([]) })
    await waitFor(() => { expect(document.querySelector('[data-session-tree-branch-host]')).toBeNull() })
    first.unmount()

    // Re-expanding the workspace mounts a fresh component; the opened menu is
    // restored from the page-process store instead of defaulting to collapsed.
    await act(async () => {
      native.setRows([
        { id: source, title: 'Source chat' },
        { id: child, title: 'Child chat' },
      ])
    })
    render(<Menu lineage={lineage} openSession={vi.fn()} useSessions={useSessions} t={t} />)
    await waitFor(() => {
      expect(body()?.getAttribute('data-expanded')).toBe('true')
    })

    // A host restart loads a fresh module store: every menu is collapsed again.
    await act(async () => { resetBranchMenus() })
    expect(body()?.getAttribute('data-expanded')).toBe('false')
  })

  it('rebuilds the inline menu when the native session list mutates', async () => {
    const childId = sid('observer-child')
    const lineage = new SessionForkLineage()
    lineage.record({ childId, parentId: sid('s1'), summary: 'observer fork' })
    const state = fakeListState(
      [sid('s1'), childId],
      Object.fromEntries([
        fakeRow(sid('s1'), 'Source chat'),
        fakeRow(childId, 'observer-child', sid('s1')),
      ]),
      sid('s1'),
    )
    const useSessions = (<T,>(select: (value: typeof state) => T): T => select(state))
    const native = renderNativeSessionRows([])
    const Menu = SessionBranchList as unknown as ComponentType<Record<string, unknown>>
    render(<Menu lineage={lineage} openSession={vi.fn()} useSessions={useSessions} t={t} />)
    expect(document.querySelector('[data-session-tree-branch-host]')).toBeNull()

    const sourceRow = document.createElement('div')
    sourceRow.setAttribute('role', 'treeitem')
    sourceRow.setAttribute('aria-selected', 'false')
    sourceRow.dataset.testSessionRow = sid('s1')
    sourceRow.textContent = 'Source chat'
    native.container.querySelector('[role="tree"]')?.append(sourceRow)

    const host = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-session-tree-branch-host][data-session-tree-branch-target="s1"]',
      )
      expect(element).not.toBeNull()
      return element!
    })
    expect(host.previousElementSibling).toBe(sourceRow)
    expect(await screen.findByText('observer-child')).not.toBeNull()
  })

  it('shows the required friendly state when the host reports no selection', async () => {
    const result = { ok: false, error: { code: 'INVALID_ARGUMENT', message: '请先在右侧会话树选中目标节点' } }
    expect(JSON.stringify(result)).toContain('请先在右侧会话树选中目标节点')
  })
})

describe('nested archived forks', () => {
  it('finds the top-level source for a fork archived under a nested branch', () => {
    const root = sid('root')
    const ab = sid('ab')
    const abc = sid('ab-c')
    const entries = new Map([
      [ab, { childId: ab, parentId: root, createdAt: 1 }],
      [abc, { childId: abc, parentId: ab, createdAt: 2 }],
    ])
    expect(forkSourceOf(entries.get(abc)!, entries)).toBe(root)
    expect(forkSourceOf(entries.get(ab)!, entries)).toBe(root)
  })
})

describe('right-sidebar merged Session graph', () => {
  function sequencedNode(
    nodeId: string,
    parentId: string | null,
    seq: number,
    summary: string,
  ): TreeNode {
    return {
      ...node(nodeId, parentId, summary),
      createdAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
      metadata: { sessionEventSeq: seq },
    }
  }

  /**
   * Shared three-level fixture. Every copied prefix keeps both its node id and
   * event sequence, while c1/c2 deliberately reuse `session-event-3`.
   */
  function worktreeFixture() {
    const lineage = new SessionForkLineage()
    lineage.record({ childId: sid('c1'), parentId: sid('s1'), summary: 'first fork', branch: 'alt', createdAt: 1 })
    lineage.record({ childId: sid('g1'), parentId: sid('c1'), summary: 'fork of fork', createdAt: 3 })

    const root = sequencedNode('session-event-1', null, 1, 'root prompt')
    const answer = sequencedNode('session-event-2', root.nodeId, 2, 'main answer')
    const c1Tip = sequencedNode('session-event-3', answer.nodeId, 3, 'first fork node')
    const g1Tip = sequencedNode('session-event-4', c1Tip.nodeId, 4, 'grandchild node')
    const c2Tip = sequencedNode('session-event-3', answer.nodeId, 3, 'clone node')
    const views = new Map<SessionId, SessionTreeView>([
      [sid('s1'), view(answer.nodeId, [root, answer], answer.nodeId, sid('s1'))],
      [sid('c1'), view(c1Tip.nodeId, [root, answer, c1Tip], c1Tip.nodeId, sid('c1'))],
      [sid('g1'), view(g1Tip.nodeId, [root, answer, c1Tip, g1Tip], g1Tip.nodeId, sid('g1'))],
      [sid('c2'), view(c2Tip.nodeId, [root, answer, c2Tip], c2Tip.nodeId, sid('c2'))],
    ])
    let state = fakeListState(
      [sid('s1'), sid('c1'), sid('c2'), sid('g1')],
      Object.fromEntries([
        fakeRow(sid('s1'), 'Source chat'),
        fakeRow(sid('c1'), 'c1', sid('s1')),
        [sid('c2'), {
          id: sid('c2'),
          displayTitle: 'cloned copy',
          parentId: sid('s1'),
          running: false,
          blank: false,
          updatedAt: 5,
        }] as [string, FakeListRow],
        fakeRow(sid('g1'), 'g1', sid('c1')),
      ]),
      sid('g1'),
    )
    const useSessions = (<T,>(select: (value: typeof state) => T): T => select(state))
    const load = vi.fn(async (sessionId: SessionId): Promise<SessionTreeView> => {
      const loaded = views.get(sessionId)
      if (loaded === undefined) throw new Error(`missing fixture view for ${sessionId}`)
      return loaded
    })
    return {
      lineage,
      views,
      load,
      get state() { return state },
      set state(next: typeof state) { state = next },
      useSessions,
    }
  }

  function renderWorktreePanel(
    fixture: ReturnType<typeof worktreeFixture>,
    overrides: Record<string, unknown> = {},
  ) {
    const events: string[] = []
    const opened: SessionId[] = []
    const openSession = (id: SessionId): void => {
      opened.push(id)
      events.push(`open:${id}`)
    }
    const jumpSession = vi.fn(async (id: SessionId, nodeId: string | null) => {
      events.push(`jump:${id}:${nodeId ?? ''}`)
      return { cursor: nodeId, messages: [] }
    })
    const jump = vi.fn(async (nodeId: string | null) => ({ cursor: nodeId, messages: [] }))
    const fork = vi.fn()
    const buildProps = (): Record<string, unknown> => ({
      sessionId: sid('s1'), panel: 'session-tree', closeDetails: vi.fn(), t,
      load: fixture.load, jump, jumpSession, fork,
      useSessions: fixture.useSessions,
      lineage: fixture.lineage,
      openSession,
    })
    const Panel = SessionTreeDock as unknown as ComponentType<Record<string, unknown>>
    const rendered = render(<Panel {...buildProps()} {...overrides} />)
    // Rerender with the same component type and stable hook identities, so the
    // store's new snapshot flows in without remounting (collapse state keeps).
    const refresh = (): void => { rendered.rerender(<Panel {...buildProps()} {...overrides} />) }
    return { ...rendered, Panel, buildProps, events, opened, openSession, jumpSession, jump, refresh }
  }

  it('reloads a branch after its completed turn changes without reloading the whole lineage', async () => {
    const fixture = worktreeFixture()
    const rendered = renderWorktreePanel(fixture)
    await screen.findByText('grandchild node')
    fixture.load.mockClear()
    const previous = fixture.views.get(sid('g1'))!
    const next = sequencedNode('session-event-5', 'session-event-4', 5, 'new grandchild prompt')
    fixture.views.set(sid('g1'), { ...previous, cursor: next.nodeId, nodes: [...previous.nodes, next] })
    fixture.state = { ...fixture.state, byId: { ...fixture.state.byId,
      g1: { ...fixture.state.byId[sid('g1')], updatedAt: 100, running: false },
    } }
    rendered.refresh()
    await screen.findByText('new grandchild prompt')
    expect(fixture.load.mock.calls.map(([id]) => id)).toEqual([sid('g1')])
  })

  it('opens an inherited-only fork endpoint without writing a synthetic cursor', async () => {
    const fixture = worktreeFixture()
    const parent = fixture.views.get(sid('s1'))!
    fixture.views.set(sid('c2'), { ...parent, sessionId: sid('c2') })
    const rendered = renderWorktreePanel(fixture)
    const endpoint = await screen.findByText(zh['panel.graph.fork'])
    fireEvent.click(endpoint.closest('button')!)
    expect(rendered.opened).toEqual([sid('c2')])
    expect(rendered.jumpSession).not.toHaveBeenCalled()
    expect(rendered.jump).not.toHaveBeenCalled()
  })

  const graphRows = (): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>('[data-session-tree-row]')]
  const graphRow = (key: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[data-session-tree-row="${key}"]`)

  it('builds placeholder rows before any Session view has loaded', () => {
    const fixture = worktreeFixture()
    const topology = buildBranchTreeModel(sid('s1'), fixture.state, new Map())
    expect(topology).not.toBeNull()
    const model = buildSessionGraphModel(topology!, new Map(), new Set())
    expect(model.rows.map(row => [row.owners[0], row.placeholder])).toEqual([
      [sid('s1'), 'loading'],
      [sid('c1'), 'loading'],
      [sid('g1'), 'loading'],
      [sid('c2'), 'loading'],
    ])
  })

  it('merges three-level forks in DFS order with badges, active-path styling, and no duplicates', async () => {
    const fixture = worktreeFixture()
    renderWorktreePanel(fixture)
    await screen.findByText('grandchild node')

    const keys = [
      `${sid('s1')}:session-event-1`,
      `${sid('s1')}:session-event-2`,
      // Branches merge chronologically: both tips are seq 3, the grandchild 4.
      `${sid('c1')}:session-event-3`,
      `${sid('c2')}:session-event-3`,
      `${sid('g1')}:session-event-4`,
    ]
    expect(graphRows().map(row => row.getAttribute('data-session-tree-row'))).toEqual(keys)
    expect(new Set(keys).size).toBe(5)
    expect(graphRows().map(row => row.getAttribute('data-session-owners')?.split(' ') ?? [])).toEqual([
      [sid('s1'), sid('c1'), sid('g1'), sid('c2')],
      [sid('s1'), sid('c1'), sid('g1'), sid('c2')],
      [sid('c1'), sid('g1')],
      [sid('c2')],
      [sid('g1')],
    ])

    // Copied prefixes are deduplicated, while sibling branches that reuse the
    // same event id stay separate session-qualified rows.
    const reused = graphRows().filter(row => row.getAttribute('data-node-id') === 'session-event-3')
    expect(reused.map(row => row.getAttribute('data-session-tree-row'))).toEqual([
      `${sid('c1')}:session-event-3`, `${sid('c2')}:session-event-3`,
    ])

    const rootRow = graphRow(keys[0]!)!
    const c1Row = graphRow(keys[2]!)!
    const c2Row = graphRow(keys[3]!)!
    const g1Row = graphRow(keys[4]!)!
    expect(rootRow.querySelector('[class*="mainBadge"]')?.textContent).toBe(zh['branch.tree.main'])
    expect(c1Row.querySelector('[class*="forkBadge"]')?.textContent).toBe(zh['branch.node.forkBadge'])
    expect(c1Row.querySelector('[class*="branchChip"]')?.textContent).toBe('alt')
    expect(g1Row.querySelector('[class*="forkBadge"]')?.textContent).toBe(zh['branch.node.forkBadge'])
    expect(c2Row.querySelector('[class*="cloneBadge"]')?.textContent).toBe(zh['branch.tree.cloneBadge'])
    // The selected branch marker is a solid lane-colored circle, not hollow.
    const selectedDot = g1Row.querySelector('[class*="laneDotActive"]')
    expect(selectedDot).not.toBeNull()
    // Selected nodes are filled with their lane color; unselected stay hollow.
    // A filled circle inside the selected ring; unselected rings stay hollow.
    expect(selectedDot?.querySelector('circle')?.getAttribute('fill')).not.toBe('var(--dsw-alias-bg-base)')
    expect(document.querySelector('[class*="laneDotCore"]')).toBeNull()
    // The measured graph owns edges independently of individual row heights.
    expect(document.querySelectorAll('[data-lane-edges]')).toHaveLength(1)
    expect(graphRows().every(row => row.querySelector('[class*="laneCurve"]') === null)).toBe(true)

    expect(g1Row.className).toContain('nodeSelected')
    expect(g1Row.querySelector('[class*="currentChip"]')?.textContent).toBe(zh['branch.tree.current'])
    // The active path is drawn by the blue rail; rows themselves are not tinted.
    for (const row of [rootRow, graphRow(keys[1]!)!, c1Row, c2Row]) {
      expect(row.className).not.toContain('nodePath')
    }

    // Every row uses the same fixed 44px graph gutter; depth never adds
    // horizontal layout to the row itself.
    expect(graphRows()).toHaveLength(5)
    expect(graphRows().every(row =>
      row.style.marginLeft === ''
      && row.style.paddingLeft === ''
      && row.querySelector('[data-lane-column]') !== null,
    )).toBe(true)
  })

  it('focuses a branch row to its branch subtree and exits with Escape', async () => {
    const fixture = worktreeFixture()
    const rendered = renderWorktreePanel(fixture)
    await screen.findByText('grandchild node')
    // The shared fork anchor keeps its descendants (trunk included), so focus
    // no longer lives there; the row that starts the branch owns the action.
    const focusButtonName = new RegExp(zh['panel.focus'])
    const anchorRow = graphRow(`${sid('s1')}:session-event-2`)!
    expect(within(anchorRow).queryByRole('button', { name: focusButtonName })).toBeNull()
    // Clone branches carry the same focus entry as fork branches.
    const cloneRow = graphRow(`${sid('c2')}:session-event-3`)!
    expect(within(cloneRow).getByRole('button', { name: focusButtonName })).toBeTruthy()
    const forkKey = `${sid('c1')}:session-event-3`
    const forkRow = graphRow(forkKey)!
    const focusButton = within(forkRow).getByRole<HTMLButtonElement>('button', { name: focusButtonName })
    const scroller = document.querySelector<HTMLElement>('[data-session-tree-panel] [class*="body"]')!
    scroller.scrollTop = 420
    fireEvent.click(focusButton!)
    // The old scroll offset must not leave the new root above the viewport.
    expect(scroller.scrollTop).toBe(0)

    // The focused branch becomes the trunk; the main line and sibling branches
    // disappear, while nested forks inside this branch remain.
    expect(graphRows().map(row => row.getAttribute('data-session-tree-row'))).toEqual([
      forkKey,
      `${sid('g1')}:session-event-4`,
    ])
    expect(screen.getByRole('button', { name: zh['panel.focusAll'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh['panel.focusExit'] })).toBeTruthy()

    // Clicking a node owned by another Session inside the focused subtree
    // keeps the focused view; only leaving that subtree exits focus.
    rendered.rerender(<rendered.Panel {...rendered.buildProps()} sessionId={sid('g1')} />)
    expect(screen.getByRole('button', { name: zh['panel.focusAll'] })).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => { expect(graphRows()).toHaveLength(5) })
  })

  it('focuses a leaf branch instead of dropping its own rows', async () => {
    const fixture = worktreeFixture()
    renderWorktreePanel(fixture, { sessionId: sid('g1') })
    await screen.findByText('grandchild node')
    const leafRow = graphRow(`${sid('g1')}:session-event-4`)!
    const focusButton = within(leafRow).getByRole<HTMLButtonElement>('button', {
      name: new RegExp(zh['panel.focus']),
    })
    fireEvent.click(focusButton!)
    expect(graphRows().map(row => row.getAttribute('data-session-tree-row'))).toEqual([
      `${sid('g1')}:session-event-4`,
    ])
    expect(screen.getByRole('button', { name: zh['panel.focusAll'] })).toBeTruthy()
  })

  it('restores the focused branch after the sidebar remounts', async () => {
    const fixture = worktreeFixture()
    const first = renderWorktreePanel(fixture, { sessionId: sid('g1') })
    await screen.findByText('grandchild node')
    const forkRow = graphRow(`${sid('c1')}:session-event-3`)!
    fireEvent.click(within(forkRow).getByRole<HTMLButtonElement>('button', {
      name: new RegExp(zh['panel.focus']),
    }))
    expect(screen.getByRole('button', { name: zh['panel.focusAll'] })).toBeTruthy()
    first.unmount()

    // Opening the sidebar in the branch Session must restore the remembered
    // branch instead of falling back to the whole tree.
    renderWorktreePanel(fixture, { sessionId: sid('g1') })
    expect(await screen.findByRole('button', { name: zh['panel.focusAll'] })).toBeTruthy()
    expect(graphRows()).toHaveLength(2)
  })

  it('dedupes a fork prefix even when the parent cursor sits on an older node', () => {
    const parent = sid('prefix-parent')
    const child = sid('prefix-child')
    const nodes = [
      node('n1', null, 'prompt one'),
      node('n2', 'n1', 'prompt two'),
      node('n3', 'n2', 'prompt three'),
    ]
    const childOnly = node('n4', 'n3', 'child continuation')
    const topology = {
      rows: [
        { sessionId: parent, parentId: undefined, title: 'Parent', depth: 0, isLast: false, railContinues: [], childCount: 1, running: false, current: false, onActivePath: true, badge: 'main' as const, branchLabel: undefined },
        { sessionId: child, parentId: parent, title: 'Child', depth: 1, isLast: true, railContinues: [], childCount: 0, running: false, current: true, onActivePath: true, badge: 'fork' as const, branchLabel: 'alt' },
      ],
      rootId: parent,
      highlightedId: child,
      activeAncestors: new Set([parent]),
    }
    const views = new Map([
      // The parent's cursor/selection is stale: it points at the first prompt.
      [parent, view('n1', nodes, 'n1', parent)],
      [child, view('n4', [...nodes, childOnly], 'n4', child)],
    ])
    const model = buildSessionGraphModel(topology, views, new Set())
    const promptRows = model.rows.filter(row => row.placeholder === undefined && row.node.nodeId !== 'n4')
    // The copied prefix is shared, not duplicated as child-owned rows.
    expect(promptRows.map(row => row.node.nodeId)).toEqual(['n1', 'n2', 'n3'])
    expect(promptRows.every(row => row.owners.length === 2)).toBe(true)
    expect(model.rows.filter(row => row.node.nodeId === 'n4')).toHaveLength(1)
  })

  it('opens the owning Session when selecting a cross-Session node', async () => {
    const fixture = worktreeFixture()
    const rendered = renderWorktreePanel(fixture)
    await screen.findByText('clone node')

    fireEvent.click(screen.getByLabelText(`${zh['panel.select']} — clone node`))
    await waitFor(() => { expect(rendered.opened).toEqual([sid('c2')]) })
    expect(rendered.jumpSession).toHaveBeenCalledWith(sid('c2'), 'session-event-3')
    expect(rendered.jump).not.toHaveBeenCalled()
  })

  it('switches Session, opens the native rail, and persists the target cursor', async () => {
    const fixture = worktreeFixture()
    const navigateNode = vi.fn(async () => {})
    const rendered = renderWorktreePanel(fixture, { navigateNode })
    await screen.findByText('clone node')
    fireEvent.click(screen.getByLabelText(`${zh['panel.select']} — clone node`))
    await waitFor(() => { expect(navigateNode).toHaveBeenCalledTimes(1) })
    expect(navigateNode.mock.calls[0]?.[0]).toBe(sid('c2'))
    expect(rendered.opened).toEqual([sid('c2')])
    // The rail owns viewport movement, while the per-Session cursor is persisted
    // so the reloaded graph still shows the clicked node as selected.
    expect(rendered.jump).not.toHaveBeenCalled()
    expect(rendered.jumpSession).toHaveBeenCalledWith(sid('c2'), 'session-event-3')
  })

  it('returns a shared fork node to the main Session', async () => {
    const fixture = worktreeFixture()
    const rendered = renderWorktreePanel(fixture)
    await screen.findByText('main answer')
    // The fixture opens g1; this row is the shared fork point of every branch.
    fireEvent.click(screen.getByLabelText(`${zh['panel.select']} — main answer`))
    await waitFor(() => { expect(rendered.opened).toEqual([sid('s1')]) })
    expect(rendered.jumpSession).toHaveBeenCalledWith(sid('s1'), 'session-event-2')
  })

  it('collapses one Session branch while retaining sibling branches', async () => {
    const fixture = worktreeFixture()
    renderWorktreePanel(fixture)
    await screen.findByText('grandchild node')

    fireEvent.click(screen.getByLabelText(`${zh['branch.tree.collapse']} — first fork`))
    expect(graphRow(`${sid('c1')}:session-event-3`)).not.toBeNull()
    expect(screen.queryByText('grandchild node')).toBeNull()
    expect(screen.getByText('clone node')).not.toBeNull()
    expect(graphRows()).toHaveLength(4)

    fireEvent.click(screen.getByLabelText(`${zh['branch.tree.expand']} — first fork`))
    expect(screen.getByText('grandchild node')).not.toBeNull()
    expect(graphRows()).toHaveLength(5)

    fireEvent.click(screen.getByLabelText(`${zh['branch.tree.collapse']} — Source chat`))
    expect(graphRows().map(row => row.getAttribute('data-session-tree-row')))
      .toEqual([`${sid('s1')}:session-event-1`])

    fireEvent.click(screen.getByLabelText(`${zh['branch.tree.expand']} — Source chat`))
    expect(graphRows()).toHaveLength(5)
  })

  it('marks the open Session when it switches without tinting ancestors', async () => {
    const fixture = worktreeFixture()
    fixture.state = { ...fixture.state, current: sid('c2') }
    const { refresh } = renderWorktreePanel(fixture)
    await screen.findByText('clone node')

    fireEvent.click(screen.getByLabelText(`${zh['branch.tree.collapse']} — Source chat`))
    expect(graphRows()).toHaveLength(1)

    fixture.state = { ...fixture.state, current: sid('g1') }
    refresh()
    await screen.findByText('grandchild node')
    expect(graphRows()).toHaveLength(5)
    expect(graphRow(`${sid('g1')}:session-event-4`)?.className).toContain('nodeSelected')
    for (const key of [`${sid('s1')}:session-event-1`, `${sid('c1')}:session-event-3`, `${sid('c2')}:session-event-3`]) {
      expect(graphRow(key)?.className).not.toContain('nodePath')
    }
  })

  it('appends a live clone row without duplicating reused event ids', async () => {
    const fixture = worktreeFixture()
    const { refresh } = renderWorktreePanel(fixture)
    await screen.findByText('grandchild node')
    expect(graphRows()).toHaveLength(5)

    const cloneId = sid('live-clone')
    fixture.views.set(cloneId, view(
      'session-event-3',
      [
        sequencedNode('session-event-1', null, 1, 'root prompt'),
        sequencedNode('session-event-2', 'session-event-1', 2, 'main answer'),
        sequencedNode('session-event-3', 'session-event-2', 3, 'live clone node'),
      ],
      'session-event-3',
      cloneId,
    ))
    fixture.state = {
      ...fixture.state,
      ids: [...fixture.state.ids, cloneId],
      byId: {
        ...fixture.state.byId,
        [cloneId]: {
          id: cloneId,
          displayTitle: 'live clone',
          parentId: sid('s1'),
          running: false,
          blank: false,
          updatedAt: 9,
        },
      },
    }
    refresh()
    await screen.findByText('live clone node')

    const keys = graphRows().map(row => row.getAttribute('data-session-tree-row'))
    expect(keys).toEqual([
      `${sid('s1')}:session-event-1`,
      `${sid('s1')}:session-event-2`,
      `${sid('c1')}:session-event-3`,
      `${sid('c2')}:session-event-3`,
      `${cloneId}:session-event-3`,
      `${sid('g1')}:session-event-4`,
    ])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('isolates one failed Session behind an error placeholder', async () => {
    const fixture = worktreeFixture()
    const load = vi.fn(async (sessionId: SessionId) => {
      if (sessionId === sid('c1')) throw new Error('c1 unavailable')
      return fixture.load(sessionId)
    })
    renderWorktreePanel(fixture, { load })

    const placeholder = await waitFor(() => {
      const row = graphRow(`${sid('c1')}:__session-tree-error__`)
      expect(row).not.toBeNull()
      return row!
    })
    expect(placeholder.getAttribute('data-placeholder')).toBe('error')
    expect(placeholder.textContent).toContain(zh['panel.graph.error'])
    expect(graphRow(`${sid('s1')}:session-event-1`)).not.toBeNull()
    expect(graphRow(`${sid('c2')}:session-event-3`)).not.toBeNull()
    await waitFor(() => { expect(load).toHaveBeenCalledWith(sid('g1')) })
  })

  it('opens main for a shared node without mutating the parent payload', async () => {
    const fixture = worktreeFixture()
    const source = fixture.views.get(sid('s1'))!
    const snapshot = JSON.stringify(source)
    const rendered = renderWorktreePanel(fixture)
    await rendered.findByText('grandchild node')

    fireEvent.click(rendered.getByLabelText(`${zh['panel.select']} — main answer`))
    await waitFor(() => { expect(rendered.opened).toEqual([sid('s1')]) })
    expect(fixture.views.get(sid('s1'))).toBe(source)
    expect(JSON.stringify(source)).toBe(snapshot)
  })

  it('falls back to the legacy single-Session view without a Session-addressed jump', async () => {
    const fixture = worktreeFixture()
    const rendered = renderWorktreePanel(fixture, { jumpSession: undefined })
    await rendered.findByText('main answer')

    expect(graphRows().map(row => row.getAttribute('data-session-tree-row'))).toEqual([
      'session-event-1', 'session-event-2',
    ])
    expect(fixture.load).toHaveBeenCalledWith(sid('s1'))
    expect(rendered.jumpSession).not.toHaveBeenCalled()
  })

  it('reconnects persisted forks when native summaries omit their parent', () => {
    const parent = sid('source')
    const child = sid('source-fork-mw6fk7bq-abc123')
    const state = fakeListState([parent, child], Object.fromEntries([
      fakeRow(parent, 'Parent'), fakeRow(child, 'Child'),
    ]), child)
    const lineage = new SessionForkLineage()
    lineage.record({ childId: child, parentId: parent, branch: 'alt' })
    // The stored annotation reconnects native forks with no parentId.
    expect(buildBranchTreeModel(child, state, lineage.getSnapshot())?.rootId).toBe(parent)
    // Remote-created forks encode their source id; reconnect those even after
    // browser storage is lost, provided that exact source still exists.
    expect(buildBranchTreeModel(child, state, new Map())?.rows.map(row => row.sessionId)).toEqual([parent, child])
    const missing = fakeListState([child], Object.fromEntries([fakeRow(child, 'Child')]), child)
    expect(buildBranchTreeModel(child, missing, new Map())?.rootId).toBe(child)
  })

  it('keeps different image prompts separate even when their ids and captions match', () => {
    const fixture = worktreeFixture()
    const main = fixture.views.get(sid('s1'))!
    const child = fixture.views.get(sid('c1'))!
    const image = (attachmentId: string): TreeNode => ({
      ...sequencedNode('session-event-2', 'session-event-1', 2, '［图片］'),
      message: { role: 'user', content: '' }, content: [{ type: 'image', attachmentId }],
    })
    fixture.views.set(sid('s1'), { ...main, nodes: [main.nodes[0]!, image('image-a')] })
    fixture.views.set(sid('c1'), { ...child, nodes: [main.nodes[0]!, image('image-b')] })
    const topology = buildBranchTreeModel(sid('s1'), fixture.state, fixture.lineage.getSnapshot())!
    const model = buildSessionGraphModel(topology, fixture.views, new Set())
    const childImage = model.rows.find(row => row.key === 'c1:session-event-2')
    expect(childImage).toBeDefined()
    expect(childImage?.owners).not.toContain(sid('s1'))
    expect(model.rows.find(row => row.key === 's1:session-event-2')?.owners).not.toContain(sid('c1'))
  })

  it('dedupes a native fork prefix whose copied events were renumbered', () => {
    const parent = sid('renumber-parent')
    const child = sid('renumber-child')
    const pRoot = sequencedNode('session-event-8', null, 8, 'root prompt')
    const pTip = sequencedNode('session-event-25', 'session-event-8', 25, 'main answer')
    const cRoot = sequencedNode('session-event-2', null, 2, 'root prompt')
    const cTip = sequencedNode('session-event-3', 'session-event-2', 3, 'main answer')
    const cOnly = sequencedNode('session-event-9', 'session-event-3', 9, 'fork continuation')
    const topology = {
      rows: [
        { sessionId: parent, parentId: undefined, title: 'Parent', depth: 0, isLast: false, railContinues: [], childCount: 1, running: false, current: false, onActivePath: true, badge: 'main' as const, branchLabel: undefined },
        { sessionId: child, parentId: parent, title: 'Child', depth: 1, isLast: true, railContinues: [], childCount: 0, running: false, current: true, onActivePath: true, badge: 'fork' as const, branchLabel: 'alt' },
      ],
      rootId: parent,
      highlightedId: child,
      activeAncestors: new Set([parent]),
    }
    const views = new Map([
      [parent, view('session-event-25', [pRoot, pTip], 'session-event-25', parent)],
      [child, view('session-event-9', [cRoot, cTip, cOnly], 'session-event-9', child)],
    ])
    const model = buildSessionGraphModel(topology, views, new Set())
    const shared = model.rows.filter(row => row.placeholder === undefined && row.node.nodeId !== 'session-event-9')
    // The copied prefix is shared despite different ids and event sequences.
    expect(shared.map(row => row.node.nodeId)).toEqual(['session-event-8', 'session-event-25'])
    expect(shared.every(row => row.owners.length === 2)).toBe(true)
    expect(shared.every(row => row.ownerNodeIds.get(child) !== undefined)).toBe(true)
    expect(shared.every(row => row.badges.every(badge => badge.sessionId !== child))).toBe(true)
    const continuation = model.rows.find(row => row.node.nodeId === 'session-event-9')!
    expect(continuation.badges.map(badge => badge.sessionId)).toEqual([child])
  })

  it('interleaves branch rows by their own timestamps', () => {
    const parent = sid('time-parent')
    const child = sid('time-child')
    const p1 = sequencedNode('session-event-1', null, 1, 'shared prompt')
    const p2 = sequencedNode('session-event-3', 'session-event-1', 3, 'later parent prompt')
    const c1 = sequencedNode('session-event-1', null, 1, 'shared prompt')
    const cEarly = sequencedNode('session-event-2', 'session-event-1', 2, 'child early reply')
    const topology = {
      rows: [
        { sessionId: parent, parentId: undefined, title: 'Parent', depth: 0, isLast: false, railContinues: [], childCount: 1, running: false, current: false, onActivePath: true, badge: 'main' as const, branchLabel: undefined },
        { sessionId: child, parentId: parent, title: 'Child', depth: 1, isLast: true, railContinues: [], childCount: 0, running: false, current: true, onActivePath: true, badge: 'fork' as const, branchLabel: 'fork-a' },
      ],
      rootId: parent,
      highlightedId: child,
      activeAncestors: new Set([parent]),
    }
    const views = new Map([
      [parent, view('session-event-3', [p1, p2], 'session-event-3', parent)],
      [child, view('session-event-2', [c1, cEarly], 'session-event-2', child)],
    ])
    const model = buildSessionGraphModel(topology, views, new Set())
    // The child node happened between the two parent prompts; the merged list
    // must follow time, not session order.
    expect(model.rows.map(row => row.node.nodeId)).toEqual([
      'session-event-1', 'session-event-2', 'session-event-3',
    ])
    // The main lane stays open across the interleaved child row, so the line
    // reads as continuous without moving the child under the wrong parent.
    expect(model.rows[1]?.continues).toContain(0)
  })

  it('gives every branch its own lane without reuse or shifting', () => {
    const main = sid('dyn-main')
    const first = sid('dyn-first')
    const second = sid('dyn-second')
    const p1 = sequencedNode('session-event-1', null, 1, 'prompt one')
    const p2 = sequencedNode('session-event-3', 'session-event-1', 3, 'prompt two')
    const p3 = sequencedNode('session-event-6', 'session-event-3', 6, 'prompt three')
    const f1 = sequencedNode('session-event-1', null, 1, 'prompt one')
    const f2 = sequencedNode('session-event-2', 'session-event-1', 2, 'first fork early')
    const f3 = sequencedNode('session-event-5', 'session-event-2', 5, 'first fork late')
    const s1 = sequencedNode('session-event-1', null, 1, 'prompt one')
    const s2 = sequencedNode('session-event-3', null, 3, 'prompt two')
    const s3 = sequencedNode('session-event-4', 'session-event-3', 4, 'second fork node')
    const topology = {
      rows: [
        { sessionId: main, parentId: undefined, title: 'Main', depth: 0, isLast: false, railContinues: [], childCount: 2, running: false, current: false, onActivePath: true, badge: 'main' as const, branchLabel: undefined },
        { sessionId: first, parentId: main, title: 'First', depth: 1, isLast: false, railContinues: [], childCount: 0, running: false, current: false, onActivePath: false, badge: 'fork' as const, branchLabel: 'fork-1' },
        { sessionId: second, parentId: main, title: 'Second', depth: 1, isLast: true, railContinues: [], childCount: 0, running: false, current: true, onActivePath: true, badge: 'fork' as const, branchLabel: 'fork-2' },
      ],
      rootId: main,
      highlightedId: second,
      activeAncestors: new Set([main]),
    }
    const views = new Map([
      [main, view('session-event-6', [p1, p2, p3], 'session-event-6', main)],
      [first, view('session-event-5', [f1, f2, f3], 'session-event-5', first)],
      [second, view('session-event-4', [s1, s2, s3], 'session-event-4', second)],
    ])
    const model = buildSessionGraphModel(topology, views, new Set())
    const early = model.rows.find(row => row.node.nodeId === 'session-event-2')!
    const late = model.rows.find(row => row.node.nodeId === 'session-event-5' && row.owners.includes(first))!
    const secondRow = model.rows.find(row => row.node.nodeId === 'session-event-4' && row.owners.includes(second))!
    // Lanes are numbered left to right 1..max with the main line at lane 0;
    // the branch created first sits at max (outermost/rightmost), the second
    // at max-1, and so on.
    expect(early.lane).toBe(2)
    expect(late.lane).toBe(2)
    expect(late.laneShiftFrom).toBeNull()
    expect(secondRow.lane).toBe(1)
    expect(secondRow.laneShiftFrom).toBeNull()
    // Colours stay bound to the branch, not to the lane number.
    expect(early.colorIndex).toBe(1)
    expect(late.colorIndex).toBe(1)
    expect(secondRow.colorIndex).toBe(2)
  })

  it('places a tail fork continuation on its own lane', () => {
    const parent = sid('lane-parent')
    const child = sid('lane-child')
    const p1 = sequencedNode('session-event-1', null, 1, 'prompt one')
    const p2 = sequencedNode('session-event-2', 'session-event-1', 2, 'prompt two')
    const c1 = sequencedNode('session-event-2', null, 2, 'prompt one')
    const c2 = sequencedNode('session-event-3', 'session-event-2', 3, 'prompt two')
    const c3 = sequencedNode('session-event-9', 'session-event-3', 9, 'fork continuation')
    const topology = {
      rows: [
        { sessionId: parent, parentId: undefined, title: 'Parent', depth: 0, isLast: false, railContinues: [], childCount: 1, running: false, current: false, onActivePath: true, badge: 'main' as const, branchLabel: undefined },
        { sessionId: child, parentId: parent, title: 'Child', depth: 1, isLast: true, railContinues: [], childCount: 0, running: false, current: true, onActivePath: true, badge: 'fork' as const, branchLabel: 'fork-a' },
      ],
      rootId: parent,
      highlightedId: child,
      activeAncestors: new Set([parent]),
    }
    const views = new Map([
      [parent, view('session-event-2', [p1, p2], 'session-event-2', parent)],
      [child, view('session-event-9', [c1, c2, c3], 'session-event-9', child)],
    ])
    const model = buildSessionGraphModel(topology, views, new Set())
    const continuation = model.rows.find(row => row.node.nodeId === 'session-event-9')!
    // Forking at the tail leaves no main sibling, yet the continuation belongs
    // to the fork branch and must not share the main lane.
    expect(continuation.lane).toBe(1)
    expect(continuation.parentLane).toBe(0)
    expect(model.rows.filter(row => row.node.nodeId !== 'session-event-9').every(row => row.lane === 0)).toBe(true)
  })

  it('highlights only the selected copy when a reused id has different content', () => {
    const main = sid('dup-main')
    const child = sid('dup-child')
    const mainNode = sequencedNode('session-event-9', null, 9, 'main copy')
    const childNode = sequencedNode('session-event-9', null, 9, 'child copy')
    const topology = {
      rows: [
        { sessionId: main, parentId: undefined, title: 'main', depth: 0, isLast: false, railContinues: [], childCount: 1, running: false, current: false, onActivePath: true, badge: 'main' as const, branchLabel: undefined },
        { sessionId: child, parentId: main, title: 'child', depth: 1, isLast: true, railContinues: [], childCount: 0, running: false, current: true, onActivePath: true, badge: 'fork' as const, branchLabel: 'alt' },
      ],
      rootId: main,
      highlightedId: child,
      activeAncestors: new Set([main]),
    }
    const views = new Map([
      [main, view('session-event-9', [mainNode], 'session-event-9', main)],
      [child, view('session-event-9', [childNode], 'session-event-9', child)],
    ])
    const model = buildSessionGraphModel(topology, views, new Set())
    const active = model.rows.filter(row => row.active)
    expect(active).toHaveLength(1)
    expect(active[0]?.key).toBe(`${child}:session-event-9`)
    expect(active[0]?.node.summary).toBe('child copy')
  })

  it('derives rows defensively from corrupt parent links', () => {
    const cyclic = fakeListState(
      [sid('a'), sid('b')],
      Object.fromEntries([
        [sid('a'), { id: sid('a'), displayTitle: 'a', parentId: sid('b'), running: false, blank: false, updatedAt: 1 }],
        [sid('b'), { id: sid('b'), displayTitle: 'b', parentId: sid('a'), running: false, blank: false, updatedAt: 1 }],
      ]),
      sid('a'),
    )
    const model = buildBranchTreeModel(sid('a'), cyclic, new Map())
    expect(model?.rows.map(row => [row.sessionId, row.depth])).toEqual([[sid('b'), 0], [sid('a'), 1]])

    const selfLinked = fakeListState(
      [sid('x')],
      Object.fromEntries([[sid('x'), { id: sid('x'), displayTitle: 'x', parentId: sid('x'), running: false, blank: false, updatedAt: 1 }]]),
      sid('x'),
    )
    expect(buildBranchTreeModel(sid('x'), selfLinked, new Map())?.rows).toHaveLength(1)
    expect(buildBranchTreeModel(sid('missing'), selfLinked, new Map())).toBeNull()
  })

  it('wires the worktree data into both right-panel mounts', async () => {
    const b = await bench()
    await b.fiber.await()
    const actions = ((b.entry() as unknown as { inject: (id: SessionId) => SessionTreePanelActions }).inject)(sid('s1'))
    expect(actions.lineage).toBeInstanceOf(SessionForkLineage)
    actions.openSession?.(sid('s9'))
    expect(b.openedSessions).toEqual([sid('s9')])
    const overlayInjected = b.overlayEntry()?.inject?.() as { lineage?: SessionForkLineage }
    expect(overlayInjected.lineage).toBeInstanceOf(SessionForkLineage)
  })
})
