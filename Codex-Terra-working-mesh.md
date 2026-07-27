# Codex Terra — Mesh Canvas work session

This marker means an active Codex Terra implementation session is working in this checkout. It will be deleted when the Mesh Canvas goal is complete.

Scope: implement the provider-agnostic Mesh Canvas vertical slice (scene/asset stores, sandboxed Three.js viewer, MCP gateway discovery and grants, renderer presentation, tests). Expected touchpoints include `src/main/mesh/`, `src/main/mcp/`, `src/main/ipc/`, `src/shared/`, `src/renderer/src/`, preload contracts, permission/profile wiring, and package metadata.

Commits:

- Slice 1 — shared mesh contracts; private model/texture vault; durable chat-owned scene service; focused service tests; Three.js dependency.
