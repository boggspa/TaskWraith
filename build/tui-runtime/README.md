# TUI Node runtime (packaged sidecar)

This directory is filled by `npm run prepare:tui-runtime` before electron-builder
packages the Developer Preview `tw` sidecar.

## Why a separate Node binary?

TaskWraith hardens Electron fuses after pack:

- `FuseV1Options.RunAsNode = false`
- `EnableNodeOptionsEnvironmentVariable = false`
- `EnableNodeCliInspectArguments = false`

That means `ELECTRON_RUN_AS_NODE=1` against the TaskWraith app binary is
**ignored** (the process starts the App, hits the single-instance lock, and
never runs the TUI). Re-enabling `RunAsNode` would be a security regression.

The preview therefore ships official standalone Node.js binaries under:

```text
process.resourcesPath/tui-runtime/<platform>-<arch>/node[.exe]
```

Launchers under `build/tui-launcher/` resolve that binary and exec
`tui/tui/cli.js`. No system Node is required for the packaged path.

## Prepare

```bash
# Host platform only
npm run prepare:tui-runtime

# macOS universal package (both slices)
npm run prepare:tui-runtime:mac

# Windows x64 + arm64 package
npm run prepare:tui-runtime:win
```

Downloaded archives cache under `build/tui-runtime/.cache/` (gitignored).
Each staged target contains the extracted `node` / `node.exe`, the Node
distribution `LICENSE`, and `NODE.json` provenance metadata with the verified
archive and license hashes.

## Do not commit binaries

`.gitignore` excludes `build/tui-runtime/**` except this README. CI and local
package scripts must run prepare before electron-builder.
