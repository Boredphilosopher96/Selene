# Desktop preview authority

Selene compiles generated React in Electron main and serves the output through the sandboxed
`selene-preview://` protocol. The renderer cannot choose compiler source.

Each `DesignerSnapshot` may carry a `selene-preview-build-ticket/v1` identity derived by the host
from the exact project, source revision, prototype graph revision, and current React binding state.
The preload bridge accepts that identity—not a `ReactSourceWorkspace`. Main resolves it back to the
current host-owned snapshot before compilation and again before publication. Project switches,
source edits, graph edits, and binding changes therefore invalidate an outstanding ticket.

`BoundPreviewBuildCoordinator` coalesces only byte-identical workspace and identity tuples. Its
bounded cache is keyed by project, source revision, graph revision, binding commitment, and
workspace digest. A failed compile has no cross-project or cross-revision last-good fallback.

The sandbox receives its initial validated prototype state with the nonce/revision-bound
`selene-preview-init` message before generated React mounts. The root remains hidden until the
initial state is installed, React commits visible content, and paint boundaries have completed.
Subsequent state, inspection, and canvas-navigation messages continue over the transferred
`MessagePort`.

AI proposal previews remain separate: the renderer submits only a proposal decision identity, and
main resolves the candidate workspace from the host-owned pending proposal before compiling it.
