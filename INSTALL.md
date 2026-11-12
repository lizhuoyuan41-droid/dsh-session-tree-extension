# Installation

## Users — install the published Bundle

### DeepSeek Harness Desktop

Open **Settings → Plugins → Market**, search for
`@ryanlee2007/dsh-session-tree` after it is published, or install the bundled
tarball from the release page, then restart the app. The desktop
plugin manager activates the carrier bundle and composes its three rows; after
the restart, `/tree` opens the panel.

On desktop builds whose `dsh plugin` command only forwards to pnpm, install
through the in-app market; current builds activate a newly installed bundle
directly.

### CLI (`0.2.2-rc.1` and newer)

The supported CLI install is one command against your profile; the
`0.2.2-rc.1` plugin manager activates the newly installed bundle:

```sh
dsh plugin --profile <profile> add @ryanlee2007/dsh-session-tree
```

or with the prebuilt carrier tarball (no install scripts, no build step).
The carrier depends on the other three packages at version `^0.1.3`; before
registry publication, supply all four tarballs to the target package manager.
A carrier tarball alone is not a fully offline distribution:

```sh
dsh plugin --profile <profile> add ryanlee2007-dsh-session-tree-0.1.3.tgz
```

The carrier package pulls its three implementation packages
(`@ryanlee2007/dsh-pi-agent-session-tree`, `@ryanlee2007/dsh-tool-session-tree`,
`@ryanlee2007/dsh-client-ui-session-tree`) as dependencies and mounts them
through its `cordis.patch.yml` composition layer. After the install, restart
the profile and check the composition:

```sh
dsh --profile <profile> --dump-config
```

The dump should contain the `pi-agent-session-tree`, `tool-session-tree`, and
`ui-session-tree` rows. In the WebUI, `/tree` opens the panel, clicking a node
binds it as the active context, and `/fork` `/clone` `/session` operate on the
tree. `session_tree`'s `context`/`session` operations report the active
`surface` mode.

### Requirements

- DeepSeek-Harness `^0.2.2-rc.1` and Cordis `~4.1.0`. The current development
  and verification baseline is `0.2.2-rc.1`.
- Node.js 22 or newer.
- No `allowBuilds` entries: the packages declare no lifecycle scripts and ship
  prebuilt artifacts.

### Uninstall

Desktop: remove the plugin from the in-app market. CLI:

```sh
dsh plugin --profile <profile> remove @ryanlee2007/dsh-session-tree
```

The composition rows disappear with the bundle entry; nothing else in the
Harness installation is touched — the plugin never modifies Harness files.

## Contributors — source integration

Building and testing the packages standalone happens in this repository
without a Harness checkout:

```sh
pnpm install
pnpm verify     # build + typecheck + pack dry-run + vitest (stock packages)
```

To run inside a DeepSeek-Harness source checkout (native branch switching via
`Session.selectMessageSurface()` and source integration):

```sh
dev/install.sh /path/to/deepseek-harness
cd /path/to/deepseek-harness
pnpm install
pnpm run build
```

The script applies `dev/session-branch-surface.patch` (optional engine
capability; skip with `ST_NO_SURFACE=1`) and `dev/harness.patch` (composition and TypeScript registration), then
copies the three packages and docs. See
[`dev/README.md`](./dev/README.md). These source patches are contributor-only and are not required for normal
installs. The current official WebUI already exposes the extensible right
Sidebar, so no UI or generated catalog patch is required.
