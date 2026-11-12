# @ryanlee2007/dsh-session-tree

Carrier Bundle for [DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness)
adding Pi-style append-only multi-branch session trees. Installing this one
package mounts all three implementation packages through its
`cordis.patch.yml` composition layer:

| Composition row | Package | Role |
|---|---|---|
| `pi-agent-session-tree` | `@ryanlee2007/dsh-pi-agent-session-tree` | `SessionTree`/`SessionTreeStore` domain service and the `sessionTree` Remote (`list`/`jump`/`fork`/`session`) |
| `tool-session-tree` | `@ryanlee2007/dsh-tool-session-tree` | `session_tree` tool, `/tree` `/fork` `/clone` `/session` commands, system-prompt section |
| `ui-session-tree` | `@ryanlee2007/dsh-client-ui-session-tree` | WebUI tree panel (native right-Sidebar tab, with an overlay fallback on older builds) |

## Install

In DeepSeek Harness Desktop, install this package from the in-app plugin market
and restart the app; the desktop plugin manager activates the bundle. On a CLI
that ships the `0.2.2-rc.1` plugin manager:

```sh
dsh plugin --profile <profile> add @ryanlee2007/dsh-session-tree
```

or install the prebuilt tarball:

```sh
dsh plugin --profile <profile> add ryanlee2007-dsh-session-tree-0.1.3.tgz
```

This package carries no code of its own: `dependencies` pulls the three
implementation packages into the profile workspace and `dsh.bundle.patch`
points the composition loader at them. Requires DeepSeek-Harness
`^0.2.2-rc.1` and Cordis `~4.1.0`; the target installation provides those
peers. The current development and verification baseline is `0.2.2-rc.1`.

See the repository README for the full feature tour, degradation behaviour on
stock Harness builds, and development instructions.

## License

MIT.
