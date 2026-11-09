import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionTreeView, TreeNode } from '@robiteame/dsh-pi-agent-session-tree/client'
import { buildBranchTreeModel, buildSessionGraphModel, firstUnsharedUserNode, focusSessionGraph } from '../src/client/session-graph.ts'

const sid = (id: string) => id as SessionId
const node = (id: string, parentId: string | null, text: string): TreeNode => ({
  nodeId: id, parentId, summary: text, branch: 'main', createdAt: '2026-11-08T00:00:00.000Z',
  message: { role: 'user', content: text },
})
const view = (id: string, nodes: TreeNode[]): SessionTreeView => ({
  sessionId: sid(id), nodes, cursor: nodes.at(-1)?.nodeId ?? null, activeBranch: 'main', branches: [],
})

describe('fork display invariants', () => {
  it('gives a fork with only inherited prompts its own connected lane', () => {
    const a = node('a', null, 'shared first prompt')
    const b = node('b', 'a', 'shared second prompt')
    const topology = buildBranchTreeModel(sid('main'), {
      ids: [sid('main'), sid('child')], byId: { main: {}, child: { parentId: 'main' } },
    }, new Map())!
    const graph = buildSessionGraphModel(topology, new Map([
      [sid('main'), view('main', [a, b])], [sid('child'), { ...view('child', [a, b]), cursor: 'a', selectedNodeId: 'a' }],
    ]), new Set())
    const tip = graph.rows.find(row => row.owners.length === 1 && row.owners[0] === 'child')
    expect(tip).toBeDefined()
    expect(tip?.parentKey).toBe('main:b')
    expect(tip?.lane).toBe(1)
    expect(tip?.badges.map(badge => badge.sessionId)).toEqual(['child'])
    expect(graph.rows.filter(row => row.node.message?.role === 'user')).toHaveLength(2)
  })

  it('keeps a third-level uncontinued fork attached to its immediate shared anchor', () => {
    const a = node('a', null, 'root')
    const b = node('b', 'a', 'child prompt')
    const topology = buildBranchTreeModel(sid('grandchild'), {
      ids: [sid('main'), sid('child'), sid('grandchild')],
      byId: { main: {}, child: { parentId: 'main' }, grandchild: { parentId: 'child' } },
    }, new Map())!
    const graph = buildSessionGraphModel(topology, new Map([
      [sid('main'), view('main', [a])], [sid('child'), view('child', [a, b])],
      [sid('grandchild'), view('grandchild', [a, b])],
    ]), new Set())
    const tip = graph.rows.find(row => row.owners.length === 1 && row.owners[0] === 'grandchild')
    expect(tip?.parentKey).toBe('child:b')
    expect(tip?.lane).not.toBe(graph.rows.find(row => row.key === 'child:b')?.lane)
    expect(graph.rows.filter(row => row.node.message?.role === 'user')).toHaveLength(2)
  })
})

describe('first own prompt detection', () => {
  it('skips the inherited prefix and returns the fork’s first typed prompt', () => {
    const shared = node('shared', null, 'inherited topic')
    const own = node('own', 'shared', 'new topic after fork')
    const child = view('child', [shared, own])
    const parent = view('parent', [shared])
    expect(firstUnsharedUserNode(child, parent)?.summary).toBe('new topic after fork')
    expect(firstUnsharedUserNode(parent, child)).toBeUndefined()
  })
})

describe('nested fork lanes', () => {
  const stamped = (id: string, parentId: string | null, text: string, createdAt: number): TreeNode => ({
    ...node(id, parentId, text), createdAt: new Date(createdAt).toISOString(),
  })

  it('gives a fork of a fork parent lane + 1 instead of lane 1', () => {
    const main = sid('main')
    const base = Date.parse('2026-11-08T13:00:00.000Z')
    const shared = stamped('session-event-1', null, 'shared prompt', base)
    const topology: Parameters<typeof buildSessionGraphModel>[0] = {
      rows: [
        { sessionId: main, parentId: undefined, title: 'main', depth: 0, isLast: false, railContinues: [], childCount: 2, running: false, current: false, onActivePath: true, badge: 'main', branchLabel: undefined, createdAt: base },
        { sessionId: sid('ab'), parentId: main, title: 'ab', depth: 1, isLast: false, railContinues: [], childCount: 1, running: false, current: false, onActivePath: false, badge: 'fork', branchLabel: undefined, createdAt: base + 1000 },
        { sessionId: sid('sibling'), parentId: main, title: 'sibling', depth: 1, isLast: true, railContinues: [], childCount: 0, running: false, current: false, onActivePath: false, badge: 'fork', branchLabel: undefined, createdAt: base + 2000 },
        { sessionId: sid('ab-c'), parentId: sid('ab'), title: 'ab-c', depth: 2, isLast: true, railContinues: [], childCount: 0, running: false, current: false, onActivePath: false, badge: 'fork', branchLabel: undefined, createdAt: base + 3000 },
      ],
      rootId: main,
      highlightedId: main,
      activeAncestors: new Set(),
    }
    const graph = buildSessionGraphModel(topology, new Map([
      [main, view('main', [shared])],
      [sid('ab'), view('ab', [shared, stamped('session-event-2', 'session-event-1', 'ab prompt', base + 1000)])],
      [sid('sibling'), view('sibling', [shared, stamped('session-event-2', 'session-event-1', 'sibling prompt', base + 2000)])],
      [sid('ab-c'), view('ab-c', [shared,
        stamped('session-event-2', 'session-event-1', 'ab prompt', base + 1000),
        stamped('session-event-3', 'session-event-2', 'ab-c prompt', base + 3000)])],
    ]), new Set())
    const lane = (text: string): number | undefined =>
      graph.rows.find(row => row.node.summary === text)?.lane
    // Two top-level branches: first-created at 2, next at 1; the nested child
    // inserts at parent + 1, so it sits outside its parent rather than lane 1.
    expect(lane('ab prompt')).toBe(2)
    expect(lane('sibling prompt')).toBe(1)
    expect(lane('ab prompt')! + 1).toBe(lane('ab-c prompt'))
    expect(lane('ab-c prompt')).toBe(3)
  })
})

describe('subtree focus', () => {
  it('keeps only the focused node and its descendants', () => {
    const main = sid('main')
    const base = Date.parse('2026-11-08T13:00:00.000Z')
    const shared = node('session-event-1', null, 'shared prompt')
    const abPrompt = { ...node('session-event-2', 'session-event-1', 'ab prompt'), createdAt: new Date(base + 1000).toISOString() }
    const abcPrompt = { ...node('session-event-3', 'session-event-2', 'ab-c prompt'), createdAt: new Date(base + 3000).toISOString() }
    const mainPrompt = { ...node('session-event-2', 'session-event-1', 'main prompt'), createdAt: new Date(base + 2000).toISOString() }
    const topology: Parameters<typeof buildSessionGraphModel>[0] = {
      rows: [
        { sessionId: main, parentId: undefined, title: 'main', depth: 0, isLast: false, railContinues: [], childCount: 1, running: false, current: false, onActivePath: true, badge: 'main', branchLabel: undefined, createdAt: base },
        { sessionId: sid('ab'), parentId: main, title: 'ab', depth: 1, isLast: true, railContinues: [], childCount: 1, running: false, current: false, onActivePath: false, badge: 'fork', branchLabel: undefined, createdAt: base + 1000 },
        { sessionId: sid('ab-c'), parentId: sid('ab'), title: 'ab-c', depth: 2, isLast: true, railContinues: [], childCount: 0, running: false, current: false, onActivePath: false, badge: 'fork', branchLabel: undefined, createdAt: base + 3000 },
      ],
      rootId: main,
      highlightedId: main,
      activeAncestors: new Set(),
    }
    const graph = buildSessionGraphModel(topology, new Map([
      [main, view('main', [shared, mainPrompt])],
      [sid('ab'), view('ab', [shared, abPrompt])],
      [sid('ab-c'), view('ab-c', [shared, abPrompt, abcPrompt])],
    ]), new Set())
    const forkRow = graph.rows.find(row => row.node.summary === 'ab prompt')!
    expect(forkRow.branchOutLanes.length).toBeGreaterThan(0)

    const focused = focusSessionGraph(graph, forkRow.key)
    expect(focused.rows.map(row => row.node.summary)).toEqual(['ab prompt', 'ab-c prompt'])
    expect(focused.rows[0]?.parentKey).toBeNull()
    expect(focused.rows[0]?.lane).toBe(0)
    expect(focused.rows[1]?.lane).toBe(1)
    expect(focused.rows[0]?.branchOutLanes).toEqual([1])
    // Filtering must not repaint surviving branches: every retained row keeps
    // its original branch colour, and the focused root keeps its own.
    for (const row of focused.rows) {
      const before = graph.rows.find(candidate => candidate.key === row.key)!
      expect(row.colorIndex).toBe(before.colorIndex)
      expect(row.branchOutColors.length).toBe(row.branchOutLanes.length)
      for (const color of row.branchOutColors) expect(color).toBeGreaterThan(0)
    }
    expect(focused.rows[0]?.colorIndex).toBe(forkRow.colorIndex)
    expect(focused.rows.some(row => row.node.summary === 'shared prompt')).toBe(false)
    expect(focused.rows.some(row => row.node.summary === 'main prompt')).toBe(false)
  })
})

describe('stable branch colours', () => {
  const stamped = (id: string, text: string, createdAt: number): TreeNode => ({
    ...node(id, null, text), createdAt: new Date(createdAt).toISOString(),
  })

  it('keeps colours when an outer branch is archived', () => {
    const main = sid('main')
    const forks = [1, 2, 3, 4, 5].map(index => sid(`branch-${index}`))
    const base = Date.parse('2026-11-08T13:00:00.000Z')
    const shared = stamped('session-event-1', 'shared prompt', base)
    const entries = new Map(forks.map((id, index) => [id, {
      childId: id,
      parentId: main,
      createdAt: base + (index + 1) * 1000,
    }]))
    const byId: Record<string, unknown> = {
      [main]: { parentId: undefined, retainedBy: { mainView: 1 }, updatedAt: 1 },
      ...Object.fromEntries(forks.map((id, index) => [id, {
        parentId: main, retainedBy: {}, updatedAt: base + (index + 1) * 1000,
      }])),
    }
    const views = new Map([
      [main, view('main', [shared])],
      ...forks.map((id, index) => [id, view(String(id), [
        shared,
        { ...stamped('session-event-2', `branch ${index + 1} prompt`, base + (index + 1) * 1000), parentId: 'session-event-1' },
      ])] as const),
    ])
    const build = (archived: Set<SessionId>): Map<string, number> => {
      const topology = buildBranchTreeModel(main, { ids: [main, ...forks], byId, current: main }, entries, archived)!
      const graph = buildSessionGraphModel(topology, views, new Set(), archived)
      const colors = new Map<string, number>()
      for (const row of graph.rows) {
        const owner = row.owners.length === 1 ? row.owners[0] : undefined
        if (owner !== undefined && forks.includes(owner)) colors.set(String(owner), row.colorIndex)
      }
      return colors
    }
    const before = build(new Set())
    const after = build(new Set([forks[0]!]))
    expect([...before.entries()].sort()).toEqual([
      ['branch-1', 1], ['branch-2', 2], ['branch-3', 3], ['branch-4', 4], ['branch-5', 5],
    ])
    // Branch 2 keeps colour 2 instead of inheriting branch 1's colour.
    expect([...after.entries()].sort()).toEqual([
      ['branch-2', 2], ['branch-3', 3], ['branch-4', 4], ['branch-5', 5],
    ])
  })
})

describe('fork lane numbering beyond four branches', () => {
  const sampled = (id: string, text: string, createdAt: number): TreeNode => ({
    ...node(id, 'session-event-1', text), createdAt: new Date(createdAt).toISOString(),
  })

  it('keeps branch 1 at max=5 instead of wrapping onto the main lane', () => {
    const shared = node('session-event-1', null, 'shared prompt')
    const topology: Parameters<typeof buildSessionGraphModel>[0] = {
      rows: [
        { sessionId: sid('main'), parentId: undefined, title: 'main', depth: 0, isLast: false, railContinues: [], childCount: 5, running: false, current: false, onActivePath: true, badge: 'main', branchLabel: undefined, createdAt: Date.parse('2026-11-08T13:00:00.000Z') },
        ...[1, 2, 3, 4, 5].map(index => ({
          sessionId: sid(`fork-${index}`),
          parentId: sid('main'),
          title: `fork-${index}`,
          depth: 1,
          isLast: index === 5,
          railContinues: [] as boolean[],
          childCount: 0,
          running: false,
          current: false,
          onActivePath: false,
          badge: 'fork' as const,
          branchLabel: undefined,
          createdAt: Date.parse(`2026-11-08T13:0${index}:00.000Z`),
        })),
      ],
      rootId: sid('main'),
      highlightedId: sid('main'),
      activeAncestors: new Set(),
    }
    const views = new Map([
      [sid('main'), view('main', [shared])],
      ...[1, 2, 3, 4, 5].map(index => [
        sid(`fork-${index}`),
        view(`fork-${index}`, [shared, sampled('session-event-2', `fork ${index} prompt`, Date.parse(`2026-11-08T13:0${index}:00.000Z`))]),
      ] as const),
    ])
    const graph = buildSessionGraphModel(topology, views, new Set())
    const lanes = [1, 2, 3, 4, 5].map(index =>
      graph.rows.find(row => row.node.summary === `fork ${index} prompt`)?.lane,
    )
    // Branch 1 sits at max (5); later branches step inward 4,3,2,1.
    expect(lanes).toEqual([5, 4, 3, 2, 1])
    expect(lanes).not.toContain(0)
  })
})

describe('fork lane nesting', () => {
  const sequenced = (id: string, parentId: string | null, text: string, createdAt: string): TreeNode => ({
    ...node(id, parentId, text), createdAt,
  })

  it('puts the first-created fork at max, then max-1, even when an empty fork row sorts first', () => {
    const shared = sequenced('session-event-1', null, 'shared prompt', '2026-11-08T11:00:00.000Z')
    const firstPrompt = sequenced('session-event-1438', 'session-event-1', 'first fork prompt', '2026-11-08T13:33:28.000Z')
    const secondPrompt = sequenced('session-event-1438', 'session-event-1', 'second fork prompt', '2026-11-08T13:34:43.000Z')
    const mainPrompt = sequenced('session-event-1438', 'session-event-1', 'main continuation', '2026-11-08T13:37:52.000Z')
    const topology: Parameters<typeof buildSessionGraphModel>[0] = {
      rows: [
        { sessionId: sid('main'), parentId: undefined, title: 'main', depth: 0, isLast: false, railContinues: [], childCount: 3, running: false, current: false, onActivePath: true, badge: 'main', branchLabel: undefined, createdAt: Date.parse('2026-11-08T13:30:00.000Z') },
        { sessionId: sid('first'), parentId: sid('main'), title: 'first', depth: 1, isLast: false, railContinues: [], childCount: 0, running: false, current: false, onActivePath: false, badge: 'fork', branchLabel: undefined, createdAt: Date.parse('2026-11-08T13:33:28.000Z') },
        { sessionId: sid('second'), parentId: sid('main'), title: 'second', depth: 1, isLast: false, railContinues: [], childCount: 0, running: false, current: false, onActivePath: false, badge: 'fork', branchLabel: undefined, createdAt: Date.parse('2026-11-08T13:34:43.000Z') },
        { sessionId: sid('empty'), parentId: sid('main'), title: 'empty', depth: 1, isLast: true, railContinues: [], childCount: 0, running: false, current: false, onActivePath: false, badge: 'fork', branchLabel: undefined, createdAt: Date.parse('2026-11-08T13:36:00.000Z') },
      ],
      rootId: sid('main'),
      highlightedId: sid('main'),
      activeAncestors: new Set(),
    }
    const graph = buildSessionGraphModel(topology, new Map([
      [sid('main'), view('main', [shared, mainPrompt])],
      [sid('first'), view('first', [shared, firstPrompt])],
      [sid('second'), view('second', [shared, secondPrompt])],
      [sid('empty'), view('empty', [shared])],
    ]), new Set())
    const laneOf = (text: string): number | undefined =>
      graph.rows.find(row => row.node.summary === text)?.lane
    expect(laneOf('first fork prompt')).toBe(3)
    expect(laneOf('second fork prompt')).toBe(2)
    expect(graph.rows.find(row => row.placeholder === 'fork')?.lane).toBe(1)
    // Rows stay in true time order: the empty fork is created last, so its
    // endpoint must not jump above prompts that happened earlier.
    const texts = graph.rows.map(row => row.node.summary)
    expect(texts.indexOf('first fork prompt')).toBeLessThan(texts.indexOf('second fork prompt'))
    expect(texts.indexOf('second fork prompt')).toBeLessThan(texts.indexOf('empty'))
    expect(graph.rows.find(row => row.placeholder === 'fork')?.node.createdAt)
      .toBe(new Date(Date.parse('2026-11-08T13:36:00.000Z')).toISOString())
  })
})
