import { describe, expect, it } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { archiveCascadeTargets, descendantSessionIds } from '../src/client/session-list.ts'

const sid = (value: string): SessionId => value as SessionId
const row = (parentId?: SessionId): Record<string, unknown> => ({ parentId, retainedBy: {}, updatedAt: 1, displayTitle: 'x' })
const state = (parents: Record<string, SessionId | undefined>): SessionListState => ({
  ids: Object.keys(parents).map(sid),
  byId: Object.fromEntries(Object.entries(parents).map(([id, parent]) => [id, row(parent)])),
}) as unknown as SessionListState

describe('descendantSessionIds', () => {
  it('collects every depth under a parent', () => {
    const list = state({
      root: undefined,
      a: sid('root'),
      b: sid('root'),
      'a-1': sid('a'),
      'a-2': sid('a'),
      'a-1-x': sid('a-1'),
    })
    expect(descendantSessionIds(list, sid('root')).sort()).toEqual(
      [sid('a'), sid('b'), sid('a-1'), sid('a-2'), sid('a-1-x')].sort(),
    )
    expect(descendantSessionIds(list, sid('a')).sort()).toEqual(
      [sid('a-1'), sid('a-2'), sid('a-1-x')].sort(),
    )
  })

  it('does not loop on cycles or duplicate a node', () => {
    // A corrupt pair where each parent points at the other still terminates.
    const list = state({
      root: sid('a'),
      a: sid('root'),
    })
    expect(descendantSessionIds(list, sid('root'))).toEqual([sid('a')])
  })
})

describe('archiveCascadeTargets', () => {
  it('archives every unarchived descendant of a newly archived parent', () => {
    const list = state({
      root: undefined,
      a: sid('root'),
      b: sid('root'),
      'a-1': sid('a'),
    })
    expect(archiveCascadeTargets(new Set(), new Set([sid('root')]), list).sort()).toEqual(
      [sid('a'), sid('b'), sid('a-1')].sort(),
    )
  })

  it('only follows the newly archived roots and skips already archived ids', () => {
    const list = state({
      root: undefined,
      a: sid('root'),
      'a-1': sid('a'),
      b: sid('root'),
      'b-1': sid('b'),
    })
    expect(archiveCascadeTargets(
      new Set([sid('root')]),
      new Set([sid('root'), sid('b')]),
      list,
    )).toEqual([sid('b-1')])
    expect(archiveCascadeTargets(
      new Set([sid('root'), sid('a')]),
      new Set([sid('root'), sid('a'), sid('a-1')]),
      list,
    )).toEqual([])
  })
})
