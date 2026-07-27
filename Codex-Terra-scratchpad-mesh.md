# Codex Terra — Mesh Canvas scratchpad

Status: active implementation. Keep this compact and update it at meaningful slice boundaries so the work survives context refreshes.

## Objective

Implement TaskWraith Mesh Canvas end to end: sandboxed 3D scene viewer, provider-agnostic MCP tools, progressive gateway discovery/direct mesh-enabled profile, permissions, user presentation, persistence, and local-asset integration coverage.

## Decisions so far

- Use Three.js as the renderer substrate; keep agent control declarative rather than script/eval based.
- First-class import formats: GLB, glTF, and OBJ with local MTL/texture dependencies copied into a private vault. USD/USDC and DCC project files remain explicit future importers rather than pretending to parse them.
- Mesh tools stay hidden behind `capability_search` / `capability_invoke` in ordinary gateway sessions. A new immutable fresh profile will expose them directly only when the *current participant/run* starts with mesh authority; a provider session's pinned catalogue never constitutes or retains that grant, and dispatch still gates every call against the current signed posture.
- Mesh gets its own `meshCanvas` permission service, distinct from surface-scoped `canvasInteraction`.
- Mesh assets are bounded to a 512 MiB total bundle and reclaimed on scene deletion, history deletion, scene replacement, and 200-scene retention eviction when no retained scene references them.
- User test assets remain read-only in Documents/Downloads. Known examples include a 103 MB OBJ, FinalBaseMesh OBJ, and GLB files under Documents.

## Work log

- Added `three@0.181.0`.
- Started shared scene contracts and private asset/scene persistence modules.
- Baseline note from user: `SettingsPanelProviders > renders every canonical TaskWraith MCP tool` already fails on master because `ensemble_control` is absent from `MCP_TOOL_GROUPED_NAMES`; address the one-line catalog fix when MCP plumbing reaches that surface.
- User clarification: grants belong to actual run participants, not sessions. Profile selection must use the current participant's effective run permissions; profile pinning is catalogue-compatibility only.
- Added token-gated `twmesh://` asset serving, chat-scoped renderer IPC, a Three.js dock viewer, explicit presentation routing, and a user-confirmed delete path.
- Verified the opt-in fixture import against the supplied 99 MB Wavefront OBJ (including its material-library sidecar) and local `world.glb`; sources stayed read-only.

## Commit log

- Slice 1 — shared mesh contracts; private model/texture vault; durable chat-owned scene service; focused service tests; Three.js dependency.
- Slice 2 — governed MCP/profile/participant authority; token-gated asset protocol; history lifecycle; local fixture coverage; permission/catalogue integration.
- Slice 3 (in progress) — preload and renderer dock viewer, user presentation routing, visual tests, and final completion checks.
