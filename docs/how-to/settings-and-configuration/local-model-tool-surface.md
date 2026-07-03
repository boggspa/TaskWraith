# How to: Local model (Ollama) tool surface

**Platform:** Electron + iOS (behavior applies to any local Ollama-backed participant)

## What it is
Local models run through Ollama get the *same* full TaskWraith tool catalog as every cloud provider, but they are **shown** a much smaller, curated set. Small local models degrade badly when handed 140+ tool names at once ("too many tools"), so TaskWraith advertises a curated **~22-tool working set** and keeps the rest reachable on demand. This is a presentation choice only — the executable surface and the security gate are unchanged.

## How the surface is shaped
1. **Advertised working set (~22 tools).** The system preamble and the native function definitions list only the common tools (read/search, edit, shell, web, todos, `goal_read`, `ask_user_question`). This is what the model sees.
2. **`tool_help` for the tail.** Every other tool stays discoverable: the model calls `tool_help` (empty name to list everything, or a name for that tool's exact arguments). `tool_help` reads from the same generated `resources/Tools.md` catalog.
3. **Full catalog stays executable.** When the model names *any* real tool — advertised or not — it runs, gated by the run's permission role at the approval seam (`executeOllamaLocalTool`). Curation never blocks execution.
4. **Constrained decoding.** On the text (JSON) protocol, TaskWraith constrains Ollama's decoding grammar to the full callable catalog, so the model can only emit a *valid* tool name — including a tail tool it just discovered via `tool_help`.

## What the run's permission role changes
- **Network denied** (global kill switch or a preview-risk model): `web_search` / `web_fetch` are dropped from the advertisement *and* the grammar, matching the gate.
- **Read-only / plan run:** file-edit and shell tools (`write_file`, `replace`, `apply_patch`, `run_shell_command`, …) are hard-denied by the gate, so they are also dropped from the advertisement. The model is told plainly that the run is read-only instead of being shown tools it could only get denied.
- **Default / workspace-write / full-access:** the full advertised set is shown; edits and shell either prompt for approval or auto-allow per your policy.

## If a local model misbehaves
- **It "forgets" a tool exists** → that's expected; the tail is intentionally hidden. It can always `tool_help` to find it.
- **It loops on empty/garbled turns** → a retry ceiling stops it after a few non-productive turns rather than nudging forever.
- **It names a tool that doesn't exist** → the call is rejected with a specific "that isn't a tool, use `tool_help`" repair, not a silent drop.

## Tips & related
- [Provider tools tab](provider-tools-tab.md) — audit the full TaskWraith tool catalog and per-provider bridge status.
- [Providers tab](providers-tab.md) — sign in and check runtime health for Ollama and the cloud providers.
- [Safety and privacy tab](safety-and-privacy-tab.md) — set the approval policies (read-only / plan / default / …) that gate every tool above.
- [Local servers tab](local-servers-tab.md) — configure the local Ollama endpoint and models.
