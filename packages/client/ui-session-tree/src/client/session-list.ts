import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Read the main-view selection across current and 0.2 Session-list shapes. */
export function currentSessionId(state: SessionListState): SessionId | undefined {
  const legacy = (state as SessionListState & { current?: SessionId }).current
  if (legacy !== undefined) return legacy
  return state.ids
    .map(id => state.byId[id])
    .find(row => (row?.retainedBy.mainView ?? 0) > 0)?.id
}

/** All live descendants of one Session, breadth-first and deduplicated. */
export function descendantSessionIds(state: SessionListState, rootId: SessionId): SessionId[] {
  const children = new Map<SessionId, SessionId[]>()
  for (const id of state.ids ?? Object.keys(state.byId ?? {}) as SessionId[]) {
    const parentId = state.byId?.[id]?.parentId
    if (parentId === undefined || parentId === id) continue
    const siblings = children.get(parentId)
    if (siblings === undefined) children.set(parentId, [id])
    else siblings.push(id)
  }
  const result: SessionId[] = []
  const seen = new Set<SessionId>([rootId])
  const queue = [...(children.get(rootId) ?? [])]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
    queue.push(...(children.get(id) ?? []))
  }
  return result
}

/** Unarchived descendants to archive after one or more parents were archived. */
export function archiveCascadeTargets(
  previous: ReadonlySet<SessionId>,
  current: ReadonlySet<SessionId>,
  state: SessionListState,
): SessionId[] {
  const targets = new Set<SessionId>()
  for (const parentId of current) {
    if (previous.has(parentId)) continue
    for (const id of descendantSessionIds(state, parentId)) {
      if (!current.has(id)) targets.add(id)
    }
  }
  return [...targets]
}
