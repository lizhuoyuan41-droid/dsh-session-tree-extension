// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionTreeView, TreeNode } from '@ryanlee2007/dsh-pi-agent-session-tree/client'
import { SessionTreeDock } from '../src/client/SessionTreePanel.tsx'
import { SessionForkLineage } from '../src/client/fork-lineage.ts'
import { zh } from '../src/client/locales.ts'
const sid = (v: string) => v as SessionId
const t = (k: string): string => (zh as Record<string, string>)[k] ?? k
const node = (id: string, parentId: string | null, text: string): TreeNode => ({ nodeId: id, parentId, summary: text, branch: 'main', createdAt: '2026-11-08T13:00:00.000Z', message: { role: 'user', content: text } })
const view = (id: string, nodes: TreeNode[]): SessionTreeView => ({ sessionId: sid(id), nodes, cursor: nodes.at(-1)?.nodeId ?? null, activeBranch: 'main', branches: [] })
describe('archive panel', () => {
  it('removes a two-node false branch', async () => {
    const main = sid('m'), fork = sid('f')
    const a = node('a', null, 'shared prompt'), b = node('b', 'a', 'main prompt')
    const c = node('c', 'a', 'fork one'), d = node('d', 'c', 'fork two')
    const lineage = new SessionForkLineage(); lineage.record({ childId: fork, parentId: main, summary: 'fork one' })
    const state = { ids: [main, fork], byId: { [main]: { parentId: undefined, retainedBy: { mainView: 1 }, updatedAt: 1 }, [fork]: { parentId: main, retainedBy: {}, updatedAt: 2 } } }
    const useSessions = (<T,>(sel: (s: typeof state) => T): T => sel(state))
    let archived: SessionId[] = []
    const listeners = new Set<() => void>()
    const archivedSource = { getSnapshot: () => archived, subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l) } }
    const Panel = SessionTreeDock as unknown as ComponentType<Record<string, unknown>>
    const props = { sessionId: main, load: async (id: SessionId) => id === main ? view('m', [a, b]) : view('f', [a, c, d]), jump: async () => ({}), jumpSession: async () => ({}), openSession: () => {}, fork: async () => ({}), useSessions, lineage, archivedSource, t, panel: 'session-tree' }
    const rendered = render(<Panel {...props} />)
    await screen.findByText('fork two')
    expect(screen.getByText('fork one')).toBeTruthy()
    await act(async () => { archived = [fork]; for (const l of listeners) l() })
    await waitFor(() => { expect(screen.queryByText('fork two')).toBeNull() })
    expect(screen.queryByText('fork one')).toBeNull()
    expect(screen.getByText('main prompt')).toBeTruthy()
    rendered.unmount(); cleanup()
  })
})
