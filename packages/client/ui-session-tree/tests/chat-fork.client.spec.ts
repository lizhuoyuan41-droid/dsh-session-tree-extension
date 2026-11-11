// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionTreeView, TreeNode } from '@ryanlee2007/dsh-pi-agent-session-tree/client'
import { forkNodeForTurn, installChatForkBridge } from '../src/client/chat-fork.ts'

const disposers: Array<() => void> = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); document.body.replaceChildren() })
function footer(turn = '2', session = 'source') {
  const root = document.createElement('div')
  root.dataset.conversationSession = session
  root.innerHTML = `<div data-turn-tail="${turn}"><div data-clock="end"><button aria-label="Branch"><svg><path /></svg></button></div></div>`
  document.body.append(root)
  return root.querySelector('button')!
}
function install(fork: (sessionId: SessionId, turn: number) => Promise<void>) {
  disposers.push(installChatForkBridge(document, () => 'Branch', fork))
}
const node = (id: string, turn: number, role = 'user', kind = 'user/message'): TreeNode => ({
  nodeId: id, parentId: null, branch: 'main', summary: id, createdAt: '',
  message: { role: role as 'user', content: id }, metadata: { turn, sessionEventType: kind },
})
const view = (nodes: TreeNode[]) => ({ nodes } as SessionTreeView)

describe('chat footer uses session-tree forks', () => {
  it('passes the clicked session and historical turn and suppresses the native handler', async () => {
    const fork = vi.fn(async () => {})
    const b = footer('2', 'old-source')
    footer('9', 'other-session')
    const native = vi.fn(); b.addEventListener('click', native)
    install(fork)
    fireEvent.click(b.querySelector('path')!)
    await waitFor(() => expect(fork).toHaveBeenCalledWith('old-source', 2))
    expect(native).not.toHaveBeenCalled()
  })
  it('leaves disabled and unrelated buttons alone', () => {
    const fork = vi.fn(async () => {})
    const b = footer(); b.setAttribute('aria-disabled', 'true')
    install(fork); fireEvent.click(b)
    b.removeAttribute('aria-disabled'); b.setAttribute('aria-label', 'Copy'); fireEvent.click(b)
    expect(fork).not.toHaveBeenCalled()
  })
  it('deduplicates concurrent clicks and shows failures without native fallback', async () => {
    let fail!: (error: Error) => void
    const fork = vi.fn(() => new Promise<void>((_, reject) => { fail = reject }))
    const b = footer(); const native = vi.fn(); b.addEventListener('click', native)
    install(fork); fireEvent.click(b); fireEvent.click(b)
    await waitFor(() => expect(fork).toHaveBeenCalledTimes(1))
    fail(new Error('STALE_FORK_POINT'))
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('最新用户轮次'))
    expect(native).not.toHaveBeenCalled()
  })
  it('restores native behavior on disposal', () => {
    const fork = vi.fn(async () => {}); const b = footer(); const native = vi.fn()
    b.addEventListener('click', native); install(fork)
    disposers.pop()!(); fireEvent.click(b)
    expect(native).toHaveBeenCalledTimes(1); expect(fork).not.toHaveBeenCalled()
  })
  it.each(['<system-reminder>my question', 'Background subagent discussion', 'Time sampled while preparing my report'])(
    'keeps human text %s eligible and excludes only explicit injected nodes', text => {
      const typed = { ...node(text, 2), metadata: { sessionEventSeq: 12 } }
      const injected = { ...node('injected context', 2), metadata: { sessionEventSeq: 13, injected: true } }
      const entries = [
        { type: 'event', event: { type: 'turn/start', seq: 10, data: { turn: 2 } } },
        { type: 'event', event: { type: 'turn/end', seq: 20 } },
      ]
      expect(forkNodeForTurn(view([typed, injected]), entries, 2)).toBe(typed)
      expect(() => forkNodeForTurn(view([injected]), entries, 2)).toThrow()
    },
  )
  it('resolves only typed prompts in the exact completed turn', () => {
    const selected = { ...node('old', 2), metadata: { sessionEventSeq: 12 } }
    const latest = { ...node('latest', 9), metadata: { sessionEventSeq: 92 } }
    const entries = [
      { type: 'event', event: { type: 'turn/start', seq: 10, data: { turn: 2 } } },
      { type: 'event', event: { type: 'turn/end', seq: 20 } },
      { type: 'event', event: { type: 'turn/start', seq: 90, data: { turn: 9 } } },
    ]
    expect(forkNodeForTurn(view([selected, latest]), entries, 2)).toBe(selected)
    expect(() => forkNodeForTurn(view([latest]), entries, 2)).toThrow()
    expect(() => forkNodeForTurn(view([selected]), entries.filter(e => e.event.type !== 'turn/end'), 2)).toThrow()
    // A missing end cannot borrow a later turn's closing boundary.
    expect(() => forkNodeForTurn(view([selected]), [entries[0]!, entries[2]!,
      { type: 'event', event: { type: 'turn/end', seq: 99 } }], 2)).toThrow()
  })
})
