/**
 * First-topic labels shared between the merged tree panel and the inline
 * branch menu. The tree panel is the only place that holds the Session views
 * needed to tell a fork's own first prompt from the inherited prefix, so it
 * records the label here and the left menu follows it live.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export interface BranchTopic {
  /** First typed user prompt after the fork boundary. */
  readonly text: string
  /** Session title at capture time; a later change means the host renamed it. */
  readonly titleAtCapture: string | undefined
}

const topics = new Map<SessionId, BranchTopic>()
let snapshot: ReadonlyMap<SessionId, BranchTopic> = new Map()
const listeners = new Set<() => void>()

export function branchTopics(): ReadonlyMap<SessionId, BranchTopic> {
  return snapshot
}

export function rememberBranchTopic(sessionId: SessionId, text: string, titleAtCapture: string | undefined): void {
  const value = text.replace(/\s+/gu, ' ').trim()
  if (value === '' || topics.has(sessionId)) return
  topics.set(sessionId, { text: value, titleAtCapture })
  snapshot = new Map(topics)
  for (const listener of listeners) listener()
}

export function subscribeBranchTopics(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Test-only: clear captured first topics between specs. */
export function resetBranchTopicsForTests(): void {
  topics.clear()
  snapshot = new Map()
  for (const listener of listeners) listener()
}
