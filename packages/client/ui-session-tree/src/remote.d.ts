/**
 * Standalone type stand-in for the generated Host remote client contract.
 *
 * The published package ships `lib/typert.remote-client.d.ts` (generated from
 * the Host FaceModel). A clean workspace checkout type-checks before that
 * artifact exists and does not link the sibling package into this package's
 * node_modules, so standalone checks resolve the same default export here.
 * `scripts/build.mjs` still bundles the generated runtime template.
 */
declare module '@robiteame/dsh-pi-agent-session-tree/remote' {
  const TYPERT_REMOTE: Record<string, unknown>
  export default TYPERT_REMOTE
}
