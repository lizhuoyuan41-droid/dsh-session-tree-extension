# Session-tree system-prompt fragment

SessionTree is the append-only projection of this agent's durable Harness
Session log. Native user, assistant, tool, and model-context events are
synchronized automatically: never duplicate ordinary turns with
`operation: "append"`.

Before answering after navigation, call `session_tree` with
`operation: "context"` and treat its root-to-cursor `messages` as the active
branch context. Use `append` only for an explicit custom tree entry not
already recorded by Harness.

To explore an alternative, call `fork` or `branch` with the latest user
`nodeId` and branch name (or `branch.summary` to record a summary); old nodes are never
modified or deleted. Use `branches` and `tree` to inspect topology, and
`snapshot.save` / `snapshot.load` for explicit export or full-tree restore.

On a Harness build with the native selected-surface API, jump/fork also
re-point the model-visible history. Without that API the tree is
projection-only: navigation moves the cursor and panel and the canonical
model history is left untouched; in projection mode the messages returned
by `context` are the branch reference, not a replacement for the history
Harness still sends. The `surface` field reported by `context` and `session`
states the active mode: native or projection.

All operations report failures as `{ok:false,error:{code,message}}`.
