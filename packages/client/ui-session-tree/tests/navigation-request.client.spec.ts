import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TreeNode } from '@ryanlee2007/dsh-pi-agent-session-tree/client'
import {
  navigationStatus,
  rememberedSelection,
  resetNavigationStateForTests,
} from '../src/client/navigation-store.ts'
import {
  currentNavigationRequest,
  requestNodeNavigation,
  resetNavigationRequestsForTests,
} from '../src/client/navigation-request.ts'

const sid = (value: string): SessionId => value as SessionId
const node = (nodeId: string): TreeNode => ({
  nodeId, parentId: null, branch: 'main', summary: nodeId, createdAt: '2026-01-01T00:00:00.000Z',
})

afterEach(() => {
  resetNavigationRequestsForTests()
  resetNavigationStateForTests()
})

describe('cross-panel navigation request', () => {
  it('switches first, then verifies, persists, and only then confirms selection', async () => {
    const events: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const request = requestNodeNavigation(
      { sessionId: sid('target'), nodeId: 'n2', node: node('n2'), switchSession: true },
      {
        prepare: async () => { events.push('prepare:done'); return { turn: 9 } },
        openSession: id => { events.push(`open:${id}`) },
        navigate: async (_id, _node, _signal, options) => {
          events.push(`navigate:start:${options.plan?.turn ?? 'none'}`)
          await gate
          events.push('navigate:done')
        },
        persist: async nodeId => { events.push(`persist:${nodeId}`) },
      },
    )
    expect(events[0]).toBe('prepare:done')
    expect(events).not.toContain('navigate:start:9')
    expect(navigationStatus().pending).toBe(true)
    release?.()
    await request
    expect(events).toEqual(['prepare:done', 'open:target', 'navigate:start:9', 'navigate:done', 'persist:n2'])
    expect(rememberedSelection().get(sid('target'))).toBe('n2')
    expect(navigationStatus().pending).toBe(false)
    expect(navigationStatus().error).toBeNull()
  })

  it('lets only the newest request confirm a selection', async () => {
    const first = requestNodeNavigation(
      { sessionId: sid('a'), nodeId: 'a2', node: node('a2'), switchSession: true },
      {
        openSession: () => {},
        navigate: (_id, _node, signal) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('superseded', 'AbortError')))
        }),
        persist: async () => {},
      },
    )
    const second = requestNodeNavigation(
      { sessionId: sid('b'), nodeId: 'b2', node: node('b2'), switchSession: true },
      {
        openSession: () => {},
        navigate: async () => {},
        persist: async () => {},
      },
    )
    await Promise.all([first, second])
    expect(currentNavigationRequest()).toBe(2)
    expect(rememberedSelection().has(sid('a'))).toBe(false)
    expect(rememberedSelection().get(sid('b'))).toBe('b2')
  })

  it('publishes a landing failure instead of a false success', async () => {
    const request = requestNodeNavigation(
      { sessionId: sid('c'), nodeId: 'c2', node: node('c2'), switchSession: false },
      {
        openSession: () => { throw new Error('must not switch an already-open Session') },
        navigate: async () => { throw new Error('跳转未落到第 7 轮：激活轮次=3') },
        persist: async () => {},
      },
    )
    await request
    expect(rememberedSelection().has(sid('c'))).toBe(false)
    expect(navigationStatus().error).toContain('第 7 轮')
  })
})

describe('cursor persistence after a confirmed landing', () => {
  it('keeps the confirmed selection when the durable cursor write fails', async () => {
    const request = requestNodeNavigation(
      { sessionId: sid('t'), nodeId: 't2', node: node('t2'), switchSession: false },
      {
        openSession: () => {},
        navigate: async () => {},
        persist: async () => { throw new Error('cursor write failed') },
      },
    )
    await request
    expect(rememberedSelection().get(sid('t'))).toBe('t2')
    expect(navigationStatus()).toMatchObject({ pending: false, error: null })
  })
})
