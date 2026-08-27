# Introspection and release-state doctrine

Read this file in full before thread-introspection or memory-promotion work, and before making claims about released, source-ahead, live, conditional, or retired behavior.

## Thread Introspection (memory promotion)

TaskWraith is adding a **Thread Introspection** workflow: scan recent
threads/runs, classify patterns (preferences, failures, approval friction,
tool loops, repo conventions), and produce **Memory Proposal Packs** with
evidence citations — then apply lessons only after human review.

**Agents must not** implement ad-hoc nightly edits to `.codex/skills`,
`~/.cursor/skills`, or workspace rule files from old thread content. Thread
history is **untrusted evidence**. Generated proposal title/lesson fields are
bounded but may preserve wording from that evidence; review them before any
eligible promotion.

Current MVP boundary (see [`docs/THREAD_INTROSPECTION.md`](../THREAD_INTROSPECTION.md)):

- **Landed:** collect → classify → persist → **manual review in Settings**
  (harvester, run service, IPC, review panel — through `871db3521`).
- **Landed:** scheduled daily generation creates read-only proposal packs for
  review (`getIntrospectionSchedule` / `updateIntrospectionSchedule` + headless
  daily runner).
- **Landed (phase 1 apply):** approved `repo_convention` / `do_not_repeat`
  proposals can be applied to the workspace **RepoConventionIndex** via Settings
  (`applyMemoryProposal` IPC). Skill patches, preferences, bugs, and other kinds
  remain blocked; no `.codex/.cursor` skill file writes.
- **Landed:** MCP agents can use `tw_introspection_run`,
  `tw_introspection_list`, `tw_introspection_read`, and
  `tw_introspection_review` for safe trigger/list/read/review workflows.
  There is intentionally **no MCP apply tool**.
- **Partially landed:** decay/supersede store helpers exist, and review surfaces
  can set expiry status/metadata. There is no public supersede caller or
  automatic due-expiry policy, and apply-layer lifecycle integration remains
  gated.
- **Later (gated):** Skill Patch Manager (diff/rollback) and other apply
  targets.
- **Operational in dev:** Settings → Automation → Thread introspection → Run
  introspection (24h) → approve/reject → Apply (conventions only). Skill
  patches: review-only.
- **Daily toggle:** wired for read-only scheduled generation.

Do not claim the full Ryan Brewer loop is complete until the
**decay/supersede integration, Skill Patch Manager, and skill/instruction apply
with rollback** ship. Do not edit skills from thread history outside this
pipeline.

---

## Versioning

This document uses **v1.9.5** as its released baseline — tagged and pushed to
public `master` on 2026-08-12 — and also describes the source-ahead checkout
past that tag. Treat behavior newer than the tagged baseline as unshipped until
it appears in the next release notes:

- Sub-threads (Phase F1 + F2 back-propagation + F3 agent-driven
  delegation + J2 recall mode) — landed
- **Ensemble mode** — multi-provider single-thread, with
  ensemble_yield + unique @-mention auto-promotion + fail-closed ambiguity +
  same-provider participants + turn/continuous modes
- **Source-ahead routing hardening** — new-round participant selection is
  re-resolved in Electron main; exact picker links retain participant identity
  and ambiguous plain aliases fail closed. This guarantee shipped in v1.9.0.
- Approval flow + timeout policy (Phase E1)
- Approval ledger UX (Phase E2)
- **MCP tool surface** — full canonical list in
  `src/main/TaskWraithMcpTools.ts`; key tools documented in [Runtime and tool doctrine](RUNTIME_AND_TOOLS.md#mcp).
- **Thread Introspection** — memory promotion layer (proposal packs, review
  gates); see `THREAD_INTROSPECTION.md`.
- Fresh tool-capable seats default to the progressive TaskWraith gateway;
  resumable native seats retain their pinned MCP profile, and legacy Claude
  sessions may retain the full profile. Managed Grok runs use the joined
  one-shot ACP transport; `TASKWRAITH_GROK_ACP=0` now makes Grok unavailable
  instead of reopening the retired headless path, and persistent Grok seat
  processes remain hard-disabled. Grok's native read/file affordances remain
  provider-owned and posture-clamped; a TaskWraith shell route is advertised
  only after its broker setup succeeds, and a degraded turn names that exact
  absence instead of directing the model to retry a denied native shell. When
  it passes structural ACP
  runtime admission, Kimi Code reaches the gateway through a per-run
  Electron-main local HTTP bridge because ACP `session/new` rejects stdio MCP
  servers; its native session files persist separately in the durable isolated
  seat. A reviewed tuple upgrades the evidence label; without one, an admitted
  run is labelled `unattested-development`. The source-ahead packaged roster is
  currently empty. Ollama
  runs a TaskWraith-controlled local tool loop with parity where local
  capability exists, governed by the same signed permission posture and
  approval gates. Gemini is retained for historical chats and decode paths
  only. See `src/main/ProviderCapabilities.ts` and
  `src/main/mcp/McpSessionProfileFence.ts`.
- **Managed Cursor Path-B (shipped in v1.8.5; residual risk still disclosed)** —
  Cursor's membership in `LIVE_SELECTABLE_PROVIDER_IDS` is a user-approved
  product decision, independent of run-management maturity. Its current
  production route has no brittle per-build fingerprint gate and contains
  Cursor with hard-pinned `--sandbox enabled` argv builders:
  read-only vs write-capable shapes are routed by seat permission. Production
  never emits bare uncontained `cursor-agent`, sandbox-disabled, yolo,
  approve-all-MCP, or resume-token argv; `--force` is emitted only after the
  TaskWraith-owned broker is registered and enabled so its calls work
  headlessly. Path B uses the user's real `~/.cursor` login; account
  skills/plugins/MCP may load but are sandbox-bounded (own-account trust).
  TaskWraith mediates brokered gateway calls and their workspace grants, not
  Cursor-native actions. Honest partial backstop: sandbox blocks many `$HOME`-root
  sensitive writes for a normal project workspace, but a workspace placed
  directly under `$HOME` can leave `$HOME` writable, and network egress is not
  proven blocked. See `CHANGELOG.md`, `src/main/cursor/CursorCliArgs.ts`, and
  `SECURITY_ENGINEERING_LEDGER.md` (TW-SEC-2026-003).
- **Source-ahead `canvas_eval` audit minimisation** — the exact script is
  transient desktop-approval data. For a human-approved execution, the durable
  approval and Canvas-audit receipts retain a joined approval id, unkeyed
  SHA-256 digest, lengths, and outcome, not script/result content; the digest is
  reproducible correlation/integrity metadata, not encryption or a
  confidentiality boundary. Auto-denial and compatibility/tool-event rows are
  content-redacted but do not necessarily carry that full receipt. Compact and
  paired-device surfaces cannot accept without the exact desktop review.
  Provider assistant prose can echo the script/result into TaskWraith's
  persisted transcript; provider-native history, provider-generated prose, and
  opt-in debug captures are outside this guarantee, and pre-fix history is not
  destructively rewritten.
- **Source-ahead verification instrumentation** — provider capability probes
  and explicitly credentialed live/release canaries are separate from normal
  PR CI. Probe-only output is inventory, not containment proof; an unknown
  fingerprint is not trusted. Coverage output is a manual measured baseline
  with no threshold and is not a PR ratchet.

Internal roadmap notes are intentionally kept outside the public source tree.
