# Thread Introspection

TaskWraith can turn everyday agent interaction history into **reviewable,
durable lessons** — preferences, failure patterns, repo conventions, and
skill updates — without letting a nightly cron silently rewrite instruction
files.

This page describes the **memory promotion** layer: how recent threads and runs
become **Memory Proposal Packs**, how each proposal is scoped and cited, and
why thread content stays **untrusted evidence** until a human approves a
distilled lesson.

Inspired by the daily "Thread Introspection" automation described by Ryan
Brewer: scan recent chats, infer preferences and struggle patterns, propose
reusable skills — but with explicit review gates and provenance.

## Problem

A naive version of this loop is dangerous:

- Old thread text is **untrusted** (prompt injection, one-off mistakes, stale
  context).
- Promoting raw prose into `.codex/skills`, `~/.cursor/skills`, or
  `AGENTS.md` creates **skill bloat** and wrong global rules.
- One bad night can overwrite good instructions.

TaskWraith already persists chats, runs, durable run events, cross-thread
recall, scheduled workflows, ensemble blackboard entries, approval ledgers,
and evidence packs. What was missing is a **first-class propose → review →
apply** primitive — not another agent that edits skills directly.

## Pipeline (target end-to-end)

```text
Daily Thread Introspection (scheduled or manual)
  → Collect evidence (last 24h threads/runs)
  → Classify signals (preferences, failures, friction, conventions)
  → Memory Proposal Pack (structured proposals + citations)
  → Human review / auto-approve low-risk scopes only
  → Apply approved items to the right durable surface
  → Ledger + supersede/expiry
```

### MVP safety boundary (current)

TaskWraith ships **read-only introspection + reviewable artifacts**, with a
**narrow phase-1 apply path** for workspace repo conventions only:

1. Collect recent run/thread evidence (harvester — **landed**, `0fd22e9a0`).
2. Classify patterns into proposal candidates (generator — **landed**).
3. Persist **Memory Proposal Packs** for review (**landed**).
4. Review proposals in Settings → Thread introspection (**landed** — IPC + mount wired).
5. **Apply phase 1 (landed):** user-approved `repo_convention` and
   `do_not_repeat` proposals can be applied to the workspace
   **RepoConventionIndex** via Settings (see [Apply phase 1](#apply-phase-1-repo-conventions-only)).
6. **Still blocked:** skill/instruction file writes, preferences, provider hints,
   failure modes, bugs, and any apply without explicit human approval.

See blackboard decisions `thread-introspection-mvp-boundary` and
`thread-introspection-apply-phase1-boundary`.

## How this differs from nearby concepts

| Concept | Scope | Thread Introspection |
| --- | --- | --- |
| **EvidencePackRecord** | Per-run capability verification (scope radar, completion claims, touched files) | Multi-run retrospective; promotes **lessons**, not run completion |
| **Ensemble Blackboard** | Ephemeral round/session/chat scratchpad (`decision`, `fact`, `risk`, `do-not-repeat`) | Durable promotion registry with status, expiry, supersession |
| **HandoffCard** | One-shot run summary for delegation | Structured proposals with evidence refs and apply targets |
| **tw_recall_*** | Bounded cross-thread read with citation honesty | Evidence substrate; introspection **consumes** recall-shaped refs |
| **RepoConventionIndex** | Workspace conventions from tree scan | One **apply target** for `repo_convention` / `do_not_repeat` proposals |

Do **not** overload `EvidencePackRecord` for user preference memory.

## Domain model

Types live in `src/main/store/types.ts`. Pure normalization and proposal
hygiene live in `src/main/introspection/`.

### IntrospectionRunRecord

One retrospective pass over a time window.

| Field | Meaning |
| --- | --- |
| `windowStart` / `windowEnd` | Evidence collection window (typically last 24h) |
| `trigger` | `manual` \| `scheduled` \| `workflow` |
| `status` | `collecting` → `analyzing` → `review_pending` → `completed` (or `failed` / `cancelled`) |
| `evidenceItems` | Normalized harvested signals |
| `proposalPackId` | Link to generated pack |

Persisted under `userData/introspection-runs.json` (history capped).

### MemoryProposalPack

Structured output of one introspection run.

| Field | Meaning |
| --- | --- |
| `proposals` | Reviewable lesson candidates |
| `evidenceItemCount` | How many signals were distilled |
| `summary` | Optional human-readable report (markdown) |
| `workspaceId` / `workspacePath` | Optional workspace scope |

Persisted under `userData/memory-proposal-packs.json` (history capped).

### MemoryProposal

One distilled lesson candidate.

**Kinds** (`MemoryProposalKind`):

| Kind | Example lesson |
| --- | --- |
| `preference` | "User prefers concise final summaries after edits." |
| `failure_mode` | "Write failures were caused by locked writer lane scope." |
| `repo_convention` | "Do not run repo-wide Prettier." |
| `provider_hint` | Provider-specific runtime hint |
| `skill_patch` | Proposed diff to a skill/instruction file (**always review-gated**) |
| `bug` | Product regression worth fixing (**always review-gated**) |
| `do_not_repeat` | Pattern to avoid repeating |

**Scopes** (`MemoryProposalScope`): `user` | `workspace` | `provider` |
`skill` | `bug`

**Statuses** (`MemoryProposalStatus`): `proposed` | `approved` | `applied` |
`rejected` | `superseded` | `expired`

Each proposal includes:

- `lesson` — distilled text (**not** raw thread prose)
- `confidence` — 0..1
- `evidenceRefs` — `{ chatId, runId?, messageId?, eventId?, timestamp, summary, citationToken?, quote? }`
- `dedupKey` — merges repeated signals across the window
- `requiresReview` — derived from kind + confidence (see below)
- `suggestedApplyTarget` — e.g. `RepoConventionIndex`, `user_rules`, `skill_file`
- `skillPatchDiff` — only when `kind === 'skill_patch'`
- `supersedesId` / `supersededById` / `expiresAt` — decay/conflict (**apply layer pending**)

### Evidence signals (generator)

`IntrospectionProposalGenerator` maps normalized `IntrospectionEvidenceItem.signal`
values to kinds/scopes. Examples:

| Signal | Kind | Default scope |
| --- | --- | --- |
| `approval_denied`, `approval_timeout` | `failure_mode` | `workspace` |
| `tool_failure`, `tool_loop` | `failure_mode` / `do_not_repeat` | `workspace` |
| `provider_error` | `failure_mode` | `provider` (when provider present) |
| `feedback_down`, `feedback_correction` | `preference` | `user` |
| `repo_convention_hint` | `repo_convention` | `workspace` |
| `skill_candidate` | `skill_patch` | `skill` |
| `product_bug` | `bug` | `bug` |

Explicit classifier scope is preserved (e.g. approval friction without a
provider stays `workspace`, not `provider`).

### Evidence harvester (collect phase)

`IntrospectionEvidenceHarvester` reads persisted substrate for a time window
and emits normalized `IntrospectionEvidenceItem` records. Sources:

| Source | Signals / heuristics |
| --- | --- |
| **Run events** | `approval_denied`, `approval_timeout`, `provider_error`, `tool_failure`, `tool_loop`, `repeated_retry` |
| **Approval ledger** | User/system denials, timer auto-deny |
| **Message feedback** | Thumbs-down, correction notes |
| **Chat messages** | User corrections after assistant replies, repo-convention phrases, skill-candidate heuristics |

Each item carries bounded summaries and optional `⟦recall:…⟧` citation tokens.
Raw thread prose is never copied into proposals verbatim.

### Manual run service

`IntrospectionRunService.runManualIntrospection()` orchestrates a single pass:

```text
load chats/events/approvals/feedback for window
  → harvestIntrospectionEvidence()
  → generateMemoryProposals()
  → persist IntrospectionRunRecord + MemoryProposalPack
  → terminal status review_pending
```

Callable from IPC (`run-manual-introspection`) and tests. Scheduled daily
generation is the next slice. Apply is a separate explicit action (phase 1:
repo conventions only — see [Apply phase 1](#apply-phase-1-repo-conventions-only)).

## Using Thread Introspection in Settings

Open **Settings → Automation → Thread introspection**.

1. **Run introspection (24h)** — harvests the last 24 hours of persisted
   threads/runs for the active workspace, generates a **Memory Proposal Pack**,
   and leaves proposals in `proposed` / `review_pending` state.
2. **Review proposals** — expand rows to see evidence citations, confidence,
   and (for `skill_patch`) a diff preview. **Approve** or **Reject** records
   review intent only. **Apply** (when shown) writes eligible approved
   `repo_convention` / `do_not_repeat` lessons to **RepoConventionIndex**;
   skill patches and other kinds stay review-only in phase 1.
3. **Enable daily run** — toggle in Settings (renderer scaffolded). When the
   schedule IPC is wired, turning this on creates a **read-only** proposal pack
   each day for review. It does **not** auto-apply lessons or edit skills.

IPC channels (read/review/apply + manual run):

| Preload API | Purpose |
| --- | --- |
| `getMemoryProposalPacks(workspaceId?)` | List packs for the review panel |
| `getMemoryProposalPack(id)` | Fetch one pack |
| `updateMemoryProposal(packId, proposalId, partial)` | Approve/reject/expire; whitelisted fields only |
| `applyMemoryProposal(packId, proposalId)` | Phase-1 apply to `RepoConventionIndex` (eligible kinds only) |
| `runManualIntrospection({ windowStart, windowEnd, workspaceId?, workspacePath? })` | Manual harvest + generate |

Schedule IPC (**in progress** — `@WriteMain` scheduler slice):

| Preload API | Purpose |
| --- | --- |
| `getIntrospectionSchedule(workspaceId?)` | Read `{ enabled, workspaceId?, lastRunAt?, nextRunAt? }` |
| `updateIntrospectionSchedule(partial)` | Enable/disable daily run; optional workspace scope |

When enabled, the backend runs `runManualIntrospection` with
`trigger: 'scheduled'` on a rolling 24h window (typically once per calendar day
per workspace). Duplicate timer fires must not create multiple scheduled packs
for the same day.

Approve/reject records review intent. **Apply** (phase 1) is a separate explicit
action for eligible approved proposals only — see [Apply phase 1](#apply-phase-1-repo-conventions-only).

## Review gates

`proposalRequiresReview(kind, confidence)`:

- **`skill_patch` and `bug`** — always require human review before any apply.
- **`preference` and `repo_convention`** — review when confidence < 0.75.
- **Other kinds** — review when confidence < 0.65.

The **Memory Proposal Review** panel (`MemoryProposalReviewPanel.tsx`) supports
approve/reject, evidence expansion, and skill-patch diff preview. For
**approved** `repo_convention` / `do_not_repeat` proposals it exposes an
**Apply** affordance that calls `applyMemoryProposal` and refreshes the pack.
Other kinds remain review-only in phase 1 (no Apply button; blocked if invoked
via IPC). Mounted in Settings via `ThreadIntrospectionSettingsPanel`.

## Scheduled daily generation (active slice)

Product ordering (blackboard `thread-introspection-next-ordering`): **scheduled
read-only generation before any apply layer**.

### What it will do (read-only)

- Once per day (24h interval or calendar-day idempotency), harvest the last 24h
  of persisted threads/runs and create a new **Memory Proposal Pack**.
- Call `runManualIntrospection` with `trigger: 'scheduled'` (optional
  `workflowId` when tied to a workflow record).
- Leave all proposals in `proposed` / `review_pending` — **no auto-approve**,
  **no skill/rule/repo mutation**.

### What it will not do

- Auto-apply lessons (scheduled runs create packs only; apply stays a separate
  explicit user action in Settings).
- Write `.codex/skills`, `~/.cursor/skills`, `AGENTS.md`, or provider instruction
  files (skill patches stay review-only until Skill Patch Manager ships).
- Apply non-convention proposal kinds in phase 1 (`preference`, `failure_mode`,
  `provider_hint`, `bug`, `skill_patch`).
- Replace human review — daily packs still require Settings approve/reject before
  any apply.
- Use agent provider dispatch (introspection is a system action, not a Codex
  prompt in a chat thread).

### Implementation notes

`WorkflowDefinition` templates today require a live chat, provider, and
prompt — introspection is not an agent turn. Expected approach:

- **Preferred MVP:** dedicated `IntrospectionScheduler` + settings record,
  piggybacking `emitDueScheduledTasks` / task timer infra (mirror headless loop
  bypass in `index.ts`).
- **Alternative:** extend workflows with a system action kind
  `thread_introspection` and headless dispatch.

Cron triggers are not yet supported on workflow definitions; use
`intervalMs: 86_400_000` or dedicated scheduler settings.

**Renderer:** `ThreadIntrospectionSettingsPanel` already exposes an **Enable
daily run** toggle and expects the schedule IPC contract above. Until Main
lands handlers, the UI shows a graceful “not wired yet” hint.

**Status:** backend scheduler + schedule IPC — **in progress** (`@WriteMain`).
Docs updated in fan-out lane B; commit with scheduler slice via `@CheckCommit`.

## Trust and prompt-injection boundary

- Thread and run content arriving at introspection is **untrusted evidence**.
- Only **`MemoryProposal.lesson`** (distilled, bounded text) may be promoted.
- **`quote`** on evidence refs is bounded and never copied verbatim into skills.
- **`citationToken`** follows recall honesty (`⟦recall:…⟧`) when served via
  `tw_recall_*`.
- Agents must **not** edit `.codex/skills`, `~/.cursor/skills`, or workspace
  rules based on old thread prose without going through proposal review.

## Substrate reuse (existing TaskWraith pieces)

| Need | Existing primitive |
| --- | --- |
| Recent runs/threads | Chat persistence, `RunQueueJob`, `RunEventStore` |
| Cross-thread citations | `tw_recall_find` / `tw_recall_read` / `tw_recall_read_events` |
| Approval friction | `ApprovalLedgerRecord`, run events `approval_*` |
| Tool loops / failures | Run event kinds (`tool`, `provider_error`, …) |
| User corrections | `MessageFeedbackLedger` |
| Per-run claims | `EvidencePackRecord` (input signals, not output store) |
| Repo do-not-repeat | `RepoConventionIndex` |
| Ensemble scratchpad | Blackboard categories (ephemeral, not registry) |
| Scheduled daily run | `WorkflowDefinition` + `WorkflowScheduler` |
| Multi-phase orchestration pattern | `AuditRunRecord` / `AuditOrchestrator` |

## Implementation status

Commits:

- `37b40c678` — domain/store/generator
- `0fd22e9a0` — harvester, run service, review UI shell, initial docs
- `871db3521` — IPC handlers + Settings tab mount
- `2d07554d9` — doc sync (IPC landed)
- `770ae3ff3` — daily schedule store, scheduler, and IPC
- `b4c55f6f1` — Settings daily schedule toggle
- `44077e6da` — phase-1 apply for low-risk repo-convention proposals
- `673a1eb11` — `tw_introspection_*` MCP tools for run/list/read/review
- `21e857890` — decay/supersede lifecycle helpers

| Slice | Status | Notes |
| --- | --- | --- |
| Domain model + normalization | **Landed** | `IntrospectionModel.ts` |
| Pure proposal generator | **Landed** | `IntrospectionProposalGenerator.ts` |
| AppStore persistence | **Landed** | `introspection-runs.json`, `memory-proposal-packs.json` |
| Evidence harvester | **Landed** | `IntrospectionEvidenceHarvester.ts` |
| Manual run service | **Landed** | `runManualIntrospection()` |
| Proposal Review UI + Settings | **Landed** | `MemoryProposalReviewPanel` + `ThreadIntrospectionSettingsPanel` |
| IPC + preload | **Landed** | `introspectionHandlers.ts` — read/review/apply |
| Apply layer (phase 1) | **Landed** | `IntrospectionApplyService.ts` — `RepoConventionIndex` only |
| Apply UI (phase 1) | **Landed** | Apply affordance for approved `repo_convention` / `do_not_repeat` proposals |
| Scheduled daily generation | **Landed** | `IntrospectionScheduler.ts` + schedule IPC/toggle |
| MCP tools | **Landed** | `tw_introspection_run`, `tw_introspection_list`, `tw_introspection_read`, `tw_introspection_review`; no MCP apply tool |
| Decay / supersede | **Landed** | `IntrospectionLifecycleService.ts` store helpers; no IPC/MCP/renderer controls yet |
| Apply layer (skills, prefs, bugs) | **Pending** | Skill Patch Manager + rollback; other kinds blocked in phase 1 |
| Distillation policy | **Pending** | Auto-approve rules per scope/kind |

**Tests:** focused introspection suites are green across handlers, harvester,
run service, scheduler, apply service, lifecycle service, MCP executors,
Settings panel, and review panel.

**Operational in dev:** Settings → Thread introspection → manual 24h run →
approve/reject → **Apply** (repo convention / do-not-repeat only). Daily
read-only generation can create reviewable packs, and MCP agents can
run/list/read/review packs through `tw_introspection_*`. **Not yet:**
skill/instruction file apply, MCP apply, full memory registry UI.

### Pipeline checklist

```text
Collect → Classify → Persist → Review → Scheduled → Apply (phase 1) → MCP → Decay/supersede
  ✅        ✅         ✅         ✅        ✅             ✅ conventions   ✅      ✅ store helpers
```

Scheduled generation creates **reviewable packs only** (no auto-apply). Phase-1
apply targets **RepoConventionIndex** only; skill patches and other kinds remain
blocked until later gated slices ship. MCP tools intentionally stop at
run/list/read/review; applying proposals remains outside the MCP surface.

## Decay / supersede lifecycle

`IntrospectionLifecycleService.ts` provides the first store-level lifecycle
helpers:

- `supersedeMemoryProposal()` links a successor and predecessor with
  `supersedesId` / `supersededById`, marks the predecessor `superseded`, and
  blocks superseding already-applied proposals.
- `expireDueMemoryProposals()` marks past-due `proposed` proposals as
  `expired` while leaving approved/applied records untouched.

These helpers are internal/store-level today. There are no Settings, IPC, MCP,
or automatic policy controls for lifecycle management yet.

## Apply phase 1 (repo conventions only)

Phase 1 is intentionally narrow: **controlled TaskWraith storage only**, after
explicit human approval in Settings. Implementation:
`IntrospectionApplyService.applyMemoryProposal()` (`apply-memory-proposal` IPC).

### Eligible proposals

| Requirement | Detail |
| --- | --- |
| **Kinds** | `repo_convention`, `do_not_repeat` only |
| **Status** | Must be `approved` (not merely `proposed`) |
| **Pack scope** | Pack must carry a `workspaceId` (workspace-scoped introspection run) |

### What apply does

1. Upserts a **RepoConventionIndex** entry for the pack's workspace:
   - Entry id: `intro-{proposalId}` (stable; re-apply updates in place)
   - Kind: `decision` for `repo_convention`, `do_not_repeat` for `do_not_repeat`
   - Title/lesson from the proposal; `provenance: 'introspection'`
2. Sets proposal `status` → `applied`, stamps `appliedAt`, and records
   `applyReceipt` (`target: 'RepoConventionIndex'`, `conventionEntryId`, pack/proposal ids).
3. Re-invoking apply on an already-`applied` proposal is **idempotent** (`ok: true`,
   returns existing receipt).

### Blocked in phase 1 (explicit `blocked` reasons)

| Kind / condition | Block reason (representative) |
| --- | --- |
| Not `approved` | `proposal_not_approved` |
| `skill_patch` | `skill_patch_not_supported_phase1` |
| `bug` | `bug_not_supported_phase1` |
| `preference` | `preference_not_supported_phase1` |
| `provider_hint` | `provider_hint_not_supported_phase1` |
| `failure_mode` | `failure_mode_not_supported_phase1` |
| Pack missing workspace | `workspace_required` |
| Unknown pack/proposal | `pack_not_found` / `proposal_not_found` |

Skill patches remain **review-only**: the review panel may show a diff preview, but
there is no unattended or one-click path to mutate `.codex/skills`, `~/.cursor/skills`,
or other instruction files. A later **Skill Patch Manager** slice will add diff preview,
approval ledger entries, and rollback before any skill file write.

### Preload contract

```typescript
applyMemoryProposal(packId, proposalId) => {
  ok: boolean
  blocked?: ApplyMemoryProposalBlockReason
  pack?: MemoryProposalPack      // updated pack when ok
  conventionEntryId?: string     // RepoConventionIndex entry id when ok
}
```

## Apply targets (full pipeline — later phases)

Beyond phase 1, approved proposals will route by kind/scope:

| Target | Proposal kinds | Phase |
| --- | --- | --- |
| `RepoConventionIndex` | `repo_convention`, `do_not_repeat` | **Phase 1 (landed)** |
| User rules / global preferences | `preference` (`scope: user`) | Later |
| Ensemble blackboard (durable export) | high-confidence `do_not_repeat` notes | Later |
| Provider runtime hints | `provider_hint`, provider-scoped `failure_mode` | Later |
| Skill Patch Manager | `skill_patch` (diff preview, approval ledger, rollback) | Later |
| Issue tracker / workspace board | `bug` | Later |

Future apply actions should write **audit ledger entries** and wire **supersede**
through the apply layer (store helpers landed; IPC/MCP/ledger integration pending).

## For agents operating in TaskWraith

- Do **not** implement "nightly skill self-edit" scripts outside this pipeline.
- Treat introspection output as **proposals**, not instructions, until status is
  `approved` or `applied`.
- Prefer citing evidence via `tw_recall_*` citation tokens when discussing
  promoted lessons.
- If the user asks for retrospective automation, point them to **Thread
  Introspection** (this doc) rather than ad-hoc `.cursor/skills` edits.

## Related docs

- [SESSION_AND_WORKSPACE.md](SESSION_AND_WORKSPACE.md) — sessions, recall posture
- [AGENTS.md](AGENTS.md) — agent runtime environment (includes introspection note)
- [ARCHITECTURE.md](ARCHITECTURE.md) — store and orchestration overview
