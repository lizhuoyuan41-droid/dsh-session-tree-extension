import { describe, expect, it } from 'vitest'
import type { TreeNode } from '@robiteame/dsh-pi-agent-session-tree/client'
import { nodeFullText } from '../src/client/node-text.ts'

const base: TreeNode = {
  nodeId: 'session-event-1',
  parentId: null,
  branch: 'main',
  summary: '［图片］',
  createdAt: '2026-01-01T00:00:00.000Z',
}

describe('node text projection', () => {
  it('falls back to the summary for an image-only prompt with empty message text', () => {
    const imageOnly: TreeNode = {
      ...base,
      message: { role: 'user', content: '' },
      content: [{ type: 'image', attachmentId: 'att-1', mediaType: 'image/png' }],
    }
    expect(nodeFullText(imageOnly)).toBe('［图片］')
  })

  it('falls back to the summary when parts and message text are both empty', () => {
    const empty: TreeNode = { ...base, message: { role: 'user', content: '' }, content: [] }
    expect(nodeFullText(empty)).toBe('［图片］')
  })

  it('keeps real prompt text unchanged', () => {
    const text: TreeNode = {
      ...base,
      summary: 'two lines',
      message: { role: 'user', content: 'two lines' },
      content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }],
    }
    expect(nodeFullText(text)).toBe('line one\nline two')
  })
})
