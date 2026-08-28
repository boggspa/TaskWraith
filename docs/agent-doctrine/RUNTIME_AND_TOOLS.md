# Runtime and tool doctrine

Read this file in full when work depends on TaskWraith runtime or session semantics, approvals, prompt caching, forks or worktrees, MCP/tool behavior, provider status, or host state an agent cannot directly see.

## Environment summary

TaskWraith is an Electron desktop app that runs coding agents in isolated
chat threads against workspaces. Each thread:

- Is bound to a configured provider runtime.
- Targets a single workspace (or runs in "global" scope without one).
- Has its own provider session, message history, run state, and
  approval policy.
- Lives under a workspace in the sidebar topology.

The desktop hosts the runtime and keeps settings, chats, run state, approvals,
usage, and pairing records under Electron `userData` by default, with provider
tools operating on workspace files through the configured workspace and policy
boundaries.

---

## Approval flow

When an agent attempts a tool call that TaskWraith's permission policy
flags as needing approval (e.g. `run_shell_command`, file edits
outside the workspace, MCP elicitations):

1. The runtime pauses the turn and emits an approval request to the
   desktop UI.
2. An auto-deny timer arms in parallel. Current defaults are Codex 60s,
   Kimi/Mistral 120s, other provider identities 240s, and main-authority
   actions 120s, with special action-kind overrides such as 180s/360s.
   Cursor retains a 240s decode/settings compatibility value. Brokered Cursor
   calls use TaskWraith policy, approval cards, and grants, while Cursor-native
   actions remain provider-owned and OS-sandbox-bounded. Retired Gemini keeps historical
   decode values only. User-visible policy remains tunable in Settings.
3. The first responder wins — desktop modal or timer.
4. A decision is written to the durable Approval Ledger (Settings →
   Automation → Approvals & Grants) including `decisionSource` (`'user'` vs
   `'system'` for timer auto-deny) and timestamp metadata.

Agents should expect timeouts as a normal outcome. If a tool call
pauses for approval and you receive a denial / cancellation a moment
later, the user may simply have been away when the timer fired — surface
the situation gracefully and offer to retry once the user is back.

## Prompt caching, forks, and worktrees (agents)

TaskWraith exposes **honest guarantee tiers** for prompt caching — do not claim
uniform provider-side caching on opaque CLI paths. When documenting or verifying
cache behavior:

- **Guaranteed (API-managed):** only where TaskWraith owns a controllable API/BYOK
  request. Current Claude and runtime-admitted Kimi paths are classified as opaque,
  best-effort transports; a saved API key alone does not make them Guaranteed.
- **Automatic (observed):** Codex provider-managed caching — record cache hits
  only when Codex reports them; TaskWraith cannot control cache breakpoints.
- **Best-effort (opaque CLI):** Claude Code, runtime-admitted Kimi, Grok, and
  Path-B Cursor — record cache stats only if the transport emits them; never
  assert cache hits you cannot see. The v1.8.4 release also classified Cursor's
  then-runnable opaque CLI path as Best effort.

**Fork:** use `/fork` or inspector fork actions. Codex = native fork; other
runnable providers (including Path-B Cursor) = **emulated fork** (linked side
chat/sub-thread). Label emulated forks accurately in user-facing text.

**Worktrees:** when `workspaceMode: worktree` is active, the effective workspace
path may differ from the sidebar checkout. Do not assume all participants share
the same working tree unless General routes locked writer lanes with explicit
write scopes.

User-facing detail: [`SESSION_AND_WORKSPACE.md`](../SESSION_AND_WORKSPACE.md).

## MCP

TaskWraith exposes a bundled MCP server (`TaskWraith`) to provider runtimes that
support brokered tools. Current tool-capable run providers are Codex, Claude,
Kimi, Cursor, Grok, Mistral Vibe, Muse, and local Ollama when their
runtime-specific admission and broker setup succeeds. The conditional
AntiGravity Gemini API-key lane advertises the TaskWraith tool catalog as Gemini function declarations and
executes those calls in-process; the official agy print-mode lane attaches no
MCP server, plugin, or **user** hook. Separately, TaskWraith may install a
temporary host-owned PreToolUse approval bridge for that print-mode lane so
native tool calls share the same Ask/approval orchestration as other providers
— that bridge is not a user-configured hooks surface.
Pi is deliberately not a generic MCP client. In an Ensemble lane only,
TaskWraith may attach one explicit app-owned Pi extension that exposes the fixed
coordination list (`ensemble_yield`, `ensemble_send`, `ensemble_fanout`,
`ensemble_poll_response`, `scout_brief`, and blackboard tools). The launch must
receive its readiness receipt before the prompt names those tools; otherwise Pi
uses unique @Role/@Model mention routing. This extension is never a shell/file
or generic MCP proxy, requires no user-installed Pi/MCP configuration, and the
host independently enforces its fixed allowlist.
The current embedded Kimi qualification roster is empty, so Kimi admission
runs in explicitly labelled `unattested-development` mode — structural
identity/probe/posture checks, always enabled, packaged builds included — and
that labelling cannot qualify a release; only a reviewed roster tuple can.
Gemini is historical/retired for new runs. **Cursor is in the user-approved
live set; its current production route is managed Path-B:** TaskWraith starts a
contained `cursor-agent` process with hard-pinned
`--sandbox enabled` and seat-routed read-only vs write argv. Path-B keeps native
Cursor tools under the OS sandbox and also registers a TaskWraith-owned gateway
broker. Brokered calls use TaskWraith policy, approval cards, and workspace
grants; native actions remain provider-owned. If registration/approval fails,
TaskWraith visibly warns and runs that turn native-only. The canonical MCP list lives in
`src/shared/taskWraithMcpCatalog.ts` (`TASKWRAITH_MCP_TOOLS`);
`src/main/TaskWraithMcpTools.ts` is only a re-export shim kept so existing
`src/main` and `src/renderer` importers keep working. The most
relevant tools an agent reaches for during day-to-day work:

**Workspace I/O (workspace-scoped, approval-gated when policy
demands):**

- `run_shell_command` — workspace-scoped shell.
- `write_file` — file write with diff capture.
- `replace` — multi-edit semantics.
- `read_file` — workspace-scoped read.
- `list_directory` — workspace-scoped tree listing.
- `workspace_search` — grep across the workspace tree.
- `workspace_symbols` — language-aware symbol lookup.
- `apply_patch` — diff/patch application.
- `git_status` / `git_diff` / `git_stage` / `git_commit` — git
  surface routed through the same approval gate as `run_shell_command`
  so the user sees the staged hunks before they land.

**Delegation + orchestration:**

<!-- prettier-ignore -->
- `delegate_to_subthread` — Phase F3 agent-driven sub-thread spawn,
  with **Phase J2 recall mode**.
  Inputs: `{ provider: ProviderId, prompt: string, model?: string,
  reasoningEffort?: string, kimiThinking?: boolean, returnResult?: boolean,
  subThreadId?: string }`, constrained to selectable providers and their current
  runtime-admission checks. By default (when `subThreadId` is omitted) the call
  spawns a fresh context-isolated sub-thread under the current parent. The
  tool_result includes the sub-thread id; pass that id as
  `subThreadId` on subsequent calls to **continue the same
  sub-thread** instead of spawning a new one — useful when you want
  back-and-forth conversation with a single delegated agent across
  multiple turns.

  Recall validates strictly: the id must belong to a sub-thread of THIS parent,
  match the requested `provider`, and not be archived. An idle child must have a
  resumable provider session; TaskWraith injects that linked id so the native
  session resumes where supported. If the child is already starting or running,
  the MCP path durably queues the follow-up behind that live turn instead of
  starting a concurrent child run. Mismatches return a structured error
  tool_result and dispatch nothing.

  When `returnResult` is true (default), the sub-thread's typed terminal result
  enters the durable parent mailbox and appears as an untrusted, projection-only
  transcript card. For solo parents, join-ready results are coalesced into one
  parent wake; failed and cancelled workers are terminal evidence rather than
  silent non-returns. Ensemble parents currently retain the mailbox/card without
  automatic participant-context delivery, as described under [Phase F2](DELEGATION_AND_ENSEMBLE.md#phase-f2--auto-propagation-of-sub-thread-results).

  **Approval gate (Phase I1):** every call routes through TaskWraith's
  `subThreadDelegation` agentic-service policy before any sub-thread
  is created. The user's workspace policy decides:

    - `'ask'` (default) → user sees a modal showing parent provider +
      target provider + the delegation prompt preview, then clicks
      Accept / Allow for session / Allow for workspace / Decline.
      Nothing spawns until the user clicks.
    - `'workspace'` → first call prompts; subsequent calls in the
      same workspace auto-approve until the workspace grant is
      revoked.
    - `'allow'` → silent auto-approve for all delegations in the
      workspace.
    - `'deny'` → silent auto-decline; tool_result returns an error.

  **What this means for the agent:** treat the tool call as something
  that might be DECLINED. Always check the tool_result for
  `isError: true`; if declined, surface the decline gracefully to
  the user (don't loop / retry) and continue the parent turn without
  delegating. The decline text explains how the user can adjust
  policy if they want.

  Typical agent use — first call (spawn):

      Agent thinks: "This step needs sandbox-restricted CLI work that
      Codex handles best. Let me delegate."

      tools.delegate_to_subthread({
        provider: 'codex',
        model: 'gpt-5.6-terra',
        reasoningEffort: 'high',
        prompt: 'Run `swift test` in this workspace and summarise the
                 first 5 failures, if any.',
        returnResult: true
      })

      → if approved: "Spawned codex sub-thread (id=abc-123). Running
      in the background; its typed terminal result will append to this parent
      transcript on completion.
      Reuse this id by passing subThreadId="abc-123" on the next
      delegate_to_subthread call if you want to continue the
      conversation with this same sub-agent."

      → if declined: "Sub-thread delegation to Codex was declined by
      TaskWraith policy. The parent turn continues without delegating; the user
      can change the policy in Settings → AI & Providers → Providers →
      Agentic services
      → Sub-thread delegation."

      Agent then continues the parent turn with non-CLI work; the
      result auto-arrives later as an untrusted tool message (only
      if the delegation was approved).

  Recall — second call (continue the SAME sub-thread):

      Agent thinks: "The Codex sub-thread reported 2 failing tests.
      I want to ask it for the full stack of the second failure
      without losing its context."

      tools.delegate_to_subthread({
        provider: 'codex',
        subThreadId: 'abc-123',
        prompt: 'Show me the full stack trace and the failing
                 assertion line for failure #2.',
        returnResult: true
      })

      → "Continued codex sub-thread (id=abc-123). Sent your prompt as
      a follow-up turn; if the child is still running, TaskWraith queues
      this turn behind it. The next typed terminal result will append to
      this parent transcript."

  Use spawn when you want a fresh context-isolated sub-agent (e.g.
  parallel tasks where each sub-thread should focus on one thing).
  Use recall when you're conversing back-and-forth with one delegated
  sub-agent across multiple turns (e.g. asking a clarifying question
  about a previous result).

  v1 constraints:
    - Max depth 1 (sub-threads can't themselves delegate).
    - Workspace inherited from parent — no cross-workspace
      delegation in v1.
    - A fresh sub-thread defaults to `model: 'cli-default'`; callers may select
      a model plus provider-compatible reasoning controls at spawn. Recall
      inherits those controls and rejects model/effort mutation. The rest of
      the composer surface is not exposed as delegation tool args.
    - Async delegated runs can never become Full Access, even when the
      invoking parent currently has a Full Access grant.
    - Fresh tool-capable seats use TaskWraith's progressive gateway MCP profile:
      a small directly advertised surface plus `capability_search` /
      `capability_invoke` for the remaining eligible catalogue. A resumable
      native session keeps the exact MCP profile it observed at birth; legacy
      Claude sessions may retain the full profile for compatibility. Grok
      receives a brokered `taskwraith` surface alongside its native shell/file
      tooling. Path-B Cursor likewise receives the gateway when its broker
      setup succeeds, alongside sandbox-bounded native tools; visible
      native-only degradation is possible when setup fails.
    - On the Kimi Code (ACP) transport, Electron main serves a per-run localhost
      HTTP MCP bridge. The native Kimi session files—not the bridge server—live
      in a durable, seat-isolated `KIMI_CODE_HOME`. Solo chats, delegated
      children, and ensemble participants resume their native ACP session from
      that seat; legacy/non-chat probes may still use a per-run home. See
      [`docs/kimi-code-acp-migration.md`](../kimi-code-acp-migration.md).
    - Ollama runs through TaskWraith's local tool loop with full tool-surface
      parity where local capability exists; the standard signed run permission
      posture and per-call approval gate decide what executes. Gemini is
      retained for historical decoding but is retired for new runs.
    - Bridge subprocesses stamp `TASKWRAITH_PARENT_PROVIDER` on their env so
      approval modals name the requesting provider and workspace grants apply
      per-provider.

- `ensemble_yield(reason?, target?)` — used inside Ensemble chats
  (multi-provider single-thread; see [Ensemble mode](DELEGATION_AND_ENSEMBLE.md#ensemble-mode-170--multi-provider-in-a-single-thread))
  to explicitly pass the current participant's turn to the next
  participant. `target` names a participant by id / provider /
  role / model alias. Round continues; user input is not required.
  Universal within the tool-capable MCP catalogue, including broker-active
  Path-B Cursor seats.

- `ask_user_question(question, options?, context?)` — **current
  critical surface.** Pauses the agent's turn and surfaces a modal
  card to the user with the question + button options (or free-text
  fallback). Returns the user's answer as the tool result so the
  agent can continue. Use this whenever you need a decision from
  the user before proceeding — for plan-mode clarifications, design
  choices, any branch point that depends on user intent.
  STRONGLY preferable to emitting the question as inline prose
  because the user gets a focused, dismissable modal with buttons
  instead of having to type a free-text reply. If the user dismisses,
  the tool returns `cancelled: true`; treat that as "skip this step"
  and continue rather than looping.

- `read_subthread_result` / `list_subthreads` / `cancel_subthread` — inspect
  sub-threads spawned via `delegate_to_subthread`, cancel their queued recalled
  follow-ups, and cancel a live child run when present.

- Provider/status and editor handoff: `agent_delegation_role`,
  `create_handoff_card`, `switch_auth_profile`, `approval_status`,
  `provider_auth_status`, `provider_usage_status`, `run_timeline`,
  `raw_provider_events`, `open_workspace_file`,
  `open_in_ide`, `open_in_ide_at_position`, `reveal_in_finder`,
  `ide_app_status`, `ide_app_capabilities`, `list_running_ides` —
  meta / introspection / editor-handoff tools (Phase L).

- Web, ensemble, goals, todos, recall, and shared-memory tools include
  `web_search`, `web_fetch`, `ensemble_send`, `ensemble_fanout`,
  `list_ensemble_participants`, goal/todo tools, blackboard tools, wakeups,
  scout briefs, and `tw_recall_*`. Check `src/shared/taskWraithMcpCatalog.ts`
  before assuming the list is complete.

- `attached_window_capture`, `attached_window_status`,
  `appwatch_start`, `appwatch_stop`, `appwatch_status`,
  `appwatch_latest_frame`, `appwatch_frames` — Phase M attached-
  window screen capture for GUI-driven debug + design work.

- `creative_app_status`, `creative_app_capabilities`,
  `creative_project_snapshot`, `creative_timeline_validate`,
  `creative_timeline_ir`, `creative_timeline_diff`,
  `creative_timeline_import`, `creative_applescript_dispatch`,
  `creative_blender_python`, `creative_midi_dispatch` — Phase K
  creative app tools (Final Cut Pro / Logic Pro / Blender).

---

## What an agent should know but can't directly see

- **Approvals are per-action, not per-session.** A grant given for one
  command doesn't carry to the next unless the user explicitly chose
  "Allow for session" or "Allow for workspace".
- **Runtime configuration** (provider, model, binary/env refs, and MCP profile)
  is recorded per thread or seat. Compatible changes can apply immediately or
  queue until the current run is idle; resumable sessions retain their pinned
  MCP profile. A new thread/sub-thread is needed only when the requested change
  cannot safely preserve the existing session.
- **Durable storage is on by default.** When local chat-history persistence is
  enabled, run events, the approval ledger, and chats survive restarts. In the
  source-ahead checkout, **Settings → General → Delete all chat history**
  removes chats, run/run-queue history, execution-graph history, the approval
  and feedback ledgers, sub-thread mailboxes, Canvas workspaces/artifacts, Kimi
  seat state, and the bridge subprocess log. It does not remove provider-native
  history or provider credentials, and it is not a persistence on/off switch.
  The v1.8.4 release did not clear the separate approval ledger.

Release-sensitive code findings and bounded containment hypotheses belong in
the Security Engineering Ledger (`SECURITY_ENGINEERING_LEDGER.md` — local-only
and gitignored at the repo root since 2026-08-11), not only in `papercuts/` or
`.local-only/` notes. Preserve an entry when a fix lands, then add owner,
status, regression evidence, and release disposition.

---
