# Codex Terra — Mesh Canvas scratchpad

Status: completed follow-up. Retained as compact context for the manual-import, QA, and reactive-scene extension.

## Objective

Implement TaskWraith Mesh Canvas end to end: sandboxed 3D scene viewer, provider-agnostic MCP tools, progressive gateway discovery/direct mesh-enabled profile, permissions, user presentation, persistence, and local-asset integration coverage.

## Decisions so far

- Use Three.js as the renderer substrate; keep agent control declarative rather than script/eval based.
- First-class import formats: GLB, glTF, and OBJ with local MTL/texture dependencies copied into a private vault. The file manager selects one exported scene/model root: a GLB is self-contained; a glTF root brings its declared sibling buffers/images; an OBJ root brings its MTL/textures. USD/USDC and native DCC project files remain explicit future importers rather than pretending to parse them.
- Mesh tools stay hidden behind `capability_search` / `capability_invoke` in ordinary gateway sessions. A new immutable fresh profile will expose them directly only when the _current participant/run_ starts with mesh authority; a provider session's pinned catalogue never constitutes or retains that grant, and dispatch still gates every call against the current signed posture.
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
- Follow-up completed: native picker labels now say “3D scene or model”; a human can import a Documents/Downloads scene root into a chat-owned scene that agents can list and edit.
- Added a main-owned, bounded, declarative dependency graph: typed object-data sources can bind to supported node properties with optional numeric scale/offset; cycles, duplicate targets, arbitrary expressions, and renderer-side raw data are rejected.
- The dock observes `scene.updated`, re-fetches the selected renderer projection, and replaces the live Three scene after a tool/graph mutation.
- Desktop QA imported real Documents and Downloads OBJ fixtures. In `FinalBaseMesh 2`, the agent-created `QA marker` was bound to `qa_live.x`, the source was updated to `1.5`, the persisted marker X resolved to `1.5`, and the scene was presented.

## Commit log

- `bb7f3c5e5` — scene persistence foundation.
- `9379f4b85` — governed MCP scene service.
- `1ac08416d` — dock viewer and presentation.
- `57fa9e371` — native user model picker.
- `248e050e9` — renderer IPC contracts.
- `f41591c93` — direct canvas entry.
- `d324959b9` — stale chat-authority recovery.
- `058d9a2fe` — Mesh Canvas review permission fixture.
- `ced62c96e` — reactive scene dependencies.
- `c379cd846` — scene-import wording clarification.

## Final verification

- Node and web TypeScript checks passed.
- Focused final coverage passed: 23 tests plus one opt-in local-fixture test correctly skipped when no explicit fixture path was supplied.
- The supplied large Wavefront OBJ with its MTL sidecar and the local `world.glb` fixture both imported successfully without modifying their source files.
- Desktop QA verified the no-error canonical-chat recovery path, two imported local scenes, the visible teal marker, and a live participant-governed `qa_live.x → QA marker.transform.position.x` update to `1.5` followed by presentation.
