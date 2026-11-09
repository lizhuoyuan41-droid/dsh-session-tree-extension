import { describe, expect, it } from 'vitest'
import { sessionEventsToTreeNodes } from '../src/session-event-adapter.ts'
import { SessionTree } from '../src/session-tree.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionTreeSidecar } from '../src/session-tree-sidecar.ts'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const imageOnly = (seq: number, id: string) => ({
  type: 'user/message' as const,
  seq,
  time: '2026-11-08T00:00:00Z',
  data: { content: [{ type: 'image', attachmentId: id }], source: { kind: 'user' } },
})

describe('image-only user turns', () => {
  it('replays and restores image history without dropping nodes or changing parents', () => {
    // Oracle: the real log's text -> image -> mixed prompt chain must survive
    // the same replay/snapshot validation used by host synchronization.
    const id = 'image-history' as SessionId
    const nodes = sessionEventsToTreeNodes([
      { ...imageOnly(165, 'unused'), data: { content: [{ type: 'text', text: 'before image' }], source: { kind: 'user' } } },
      imageOnly(870, 'first-image'),
      { ...imageOnly(2242, 'unused'), data: { content: [
        { type: 'image', attachment: { attachmentId: 'second-image', mediaType: 'image/webp' } },
        { type: 'text', text: 'after image' },
      ], source: { kind: 'user' } } },
    ] as never)
    const tree = new SessionTree(id)
    expect(tree.replay(nodes.map((node, seq) => ({ seq, node })))).toEqual({ ok: true, value: { applied: 3 } })
    const restored = new SessionTree(id, JSON.parse(JSON.stringify(tree.snapshot())))
    expect(restored.list().map(node => [node.nodeId, node.parentId])).toEqual([
      ['session-event-165', null],
      ['session-event-870', 'session-event-165'],
      ['session-event-2242', 'session-event-870'],
    ])
    expect(nodes[2]?.content?.[0]).toEqual({ type: 'image', attachmentId: 'second-image', mediaType: 'image/webp' })
  })

  it('invalidates old projections that may have silently skipped image nodes', () => {
    const root = mkdtempSync(join(tmpdir(), 'session-tree-image-cache-'))
    try {
      const id = 'stale-images' as SessionId
      const tree = new SessionTree(id)
      writeFileSync(join(root, `${id}.json`), JSON.stringify({ version: 2, sessionId: id, savedAt: 1, snapshot: tree.snapshot() }))
      expect(new SessionTreeSidecar(root).load(id)).toBeUndefined()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('still rejects malformed image references during replay', () => {
    const node = sessionEventsToTreeNodes([imageOnly(870, 'first-image')] as never)[0]!
    const tree = new SessionTree('invalid-image' as SessionId)
    expect(tree.replay([{ seq: 0, node: { ...node, content: [{ type: 'image', attachmentId: 12 }] } as never }]).ok).toBe(false)
    expect(tree.list()).toHaveLength(0)
  })

  it('keeps every image turn as its own labelled node', () => {
    // Oracle: three real turns must stay three tree nodes; collapsing them by an
    // empty summary is exactly the offset bug.
    const nodes = sessionEventsToTreeNodes([
      imageOnly(2, 'a'), imageOnly(3, 'b'), imageOnly(4, 'c'),
    ] as never, null)
    expect(nodes).toHaveLength(3)
    expect(nodes.map(node => node.nodeId)).toEqual([
      'session-event-2', 'session-event-3', 'session-event-4',
    ])
    expect(nodes.every(node => node.summary.includes('图片'))).toBe(true)
    expect(nodes.every(node => node.content?.some(part => part.type === 'image'))).toBe(true)
  })
})
