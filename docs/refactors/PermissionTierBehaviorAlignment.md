# Permission Tier Behavior Alignment

Owner decision record + build plan. Commissioned by Chris 2026-08-04 in the same
directive as the tier label rename (landed `75075fecc`: Plan / Ask / Accept
Edits / Full WS Access / Full Access — labels only, ids unchanged). This doc
maps the SHOULD-behave spec onto the current enforcement machinery and slices
the work. Work happens on `master` in the shared tree with `.WORK-IN-PROGRESS-*`
markers and explicit-path (`--only`) commits — no self-created worktrees or
topic branches, whatever any earlier handoff said.

## Target semantics (Chris, 2026-08-04, verbatim intent)

| Tier (id) | Target behavior |
| --- | --- |
| Plan (`plan`) | Read-only. NO mid-run permission asks — "denied and no elevation offered". The ONLY elevation is the proposed-plan document approval, which flips the chat to Accept Edits and re-dispatches (already exists: ProposedPlanApprovalModal). Keeps the one product-managed markdown plan-artifact write (already exists). Git snapshot/read/list, web search, blackboard, ToDos auto-allowed. No provider-native tools except web search / git / read. |
| Ask (`read_only`) | Same read auto-allow floor as Plan, plus: ANY tool not auto-allowed MAY be asked via the approval modal (user / Boss / Captain) — **NO auto-deny**. No plan-doc requirement. No provider-native tools except web search / git / read. |
| Accept Edits (`default`) | Auto-accept all in-workspace file changes (landed 2026-08-04, slice A). Non-destructive shell auto-allowed; DESTRUCTIVE shell asks instead of denying. Provider-native tools available on request — ask ONCE on first call, then auto for Edit/Search/Write/Create. TaskWraith tools all auto-approve. externalPublish (git_push / git_create_pr): **ASK** (owner ruling below). |
| Full WS Access (`workspace_write`) | Everything auto in-workspace incl. shell; `rm -rf` always githook-blocked+ask; Computer Use/AppDrive, Canvas (all kinds), media tools auto; reads OUTSIDE workspace auto-approved; writes outside workspace ASK; read processes auto, system-process changes ask once; creative apps auto on user request; remote/SSH ASK; remote network ASK; native provider tools auto (Edit/Shell/Bash/Search/Write/Create). externalPublish: **AUTO** (owner ruling below). |
| Full Access (`full_access`) | Everything auto, no prompts, EXCEPT: remote/SSH ASK; remote network ASK; `rm -rf` OUTSIDE workspace githook-blocked+ask (inside workspace always approve). Native provider tools unrestricted. externalPublish: **AUTO**. |

Boss/Captain retain their ensemble authority over ensemble tool calls at every
tier.

### Owner rulings (AskUserQuestion, 2026-08-04)

1. **Implement the full arc** (not audit-only).
2. **externalPublish (git_push / git_create_pr): auto-allow at Full WS Access
   and Full Access; ASK at Accept Edits.** This supersedes the 2026-07-03
   "externalPublish stays non-grantable by design" decision for the two write
   tiers. Below Accept Edits: not auto-allowed (Ask may prompt for it; Plan
   never asks ⇒ effectively unavailable).

## Landed so far

- **Slice A (2026-08-04):** `default` preset gained
  `agenticServices: { fileChanges: 'allow' }` — Accept Edits auto-accepts
  in-workspace edits; global deny + external-path force-prompt + preview-risk
  clamp all still win. Red-first ladder test in EffectiveRunPermissions.test.ts;
  the grants-merge test deliberately re-pinned 'workspace' → 'allow'.
- Preset `label:` metadata aligned (missed case variants of the rename).

## Remaining slices (dependency order) with mechanism anchors

### B — externalPublish tier split (owner ruling 2) — VERIFIED ALREADY HELD, pinned 2026-08-04
Measured on master: the ruling's target state was already the implemented
behavior. The approval gate (ApprovalOrchestration ~505) keeps externalPublish
approval-only ONLY for read_only/plan via `isPostureApprovalOnlyService`; the
workspace_write and full_access presets carry `externalPublish: 'allow'`, which
auto-allows through the normal audited policy path; `default` resolves the
global 'ask'. `externalPublishPolicyDecision` (index.ts ~4966) is the RECEIPTS
layer, not the prompt — it only hard-denies on global 'deny' and stamps the
audit reason; publish receipts are written by the executors regardless of how
approval was obtained (WorkspaceToolExecutors beginExternalPublishReceipt).
The earlier "non-grantable per-action publish gate" memory described the
pre-1.8.6 state and is stale. Pinned by the externalPublish ladder test in
EffectiveRunPermissions.test.ts (per-preset policy + hold membership +
global-deny survival). No code change required.

### C — Ask/Plan ask-semantics inversion — LANDED 2026-08-04 (`4563966d4`)
Everything below was implemented as specified, with these recorded decisions:
- read_only ("Ask") asks for every gated service except mediaRecording (the one
  auto-deny: no attended capture flow exists to approve); canvasEval stays
  non-grantable so its ask can never become automatic. plan denies everything.
- The read_only grant-hold widened to every asked mutating service (mcpTools
  exempt — pre-inversion grant behavior; externalPublish exempt — posture hold).
  plan's hold set is now empty (deny needs no hold).
- PRESET_AUTHORITY_RANK: plan 0 < read_only 1 < default 2; reroute escalation
  guard direction flipped with it.
- READ_ONLY_ROUND_PERMISSION_PRESET_SET = {read_only, plan}: a read-only round
  may assign its own baseline or the narrower floor; write tiers reject. (The
  round's own baseline cannot be "an unlock".)
- EVERY automatic/unattended posture now falls back to the plan no-ask floor
  instead of read_only: P1b unattended round clamp + P2 fallback (orchestrator,
  networkAccess force-denied in every unattended posture), unattended solo
  composer fallback, sub-thread mailbox auto-continuation, and the HMAC
  tamper/unsigned fail-safe in AgentRunNormalizer (an untrusted payload must
  never gain the power to raise attacker-shaped prompts). Attended read_only
  stamps (runtime-profile tightening, sub-thread worker baseline) keep the Ask
  surface deliberately.
- Ensemble prompt shell tells Ask seats writes run only on approved request;
  OllamaToolsDoc vocabulary flipped and resources/Tools.md regenerated.
- ~40k main-process tests green post-change; the only remaining failures are
  the documented pre-existing set plus one load-flaky lock process-integration
  test that passes solo.

Original design notes (for archaeology):
Today (posture split, docs in EffectiveRunPermissions.ts): `read_only` is the
deny-floor with ONE ask instrument (webBrowsing, user decision 2026-08-04);
`plan` carries the ask-instrument belt. The spec INVERTS who may ask mid-run.
Required, in one atomic slice because tests pin the pair:
- READ_ONLY_AGENTIC_SERVICES: every 'deny' → 'ask' EXCEPT mediaRecording
  (non-existent capture stays deny) — keep `readOnly: true` so writes still
  cannot EXECUTE without the modal; canvasEval becomes 'ask' (non-grantable
  keeps it per-invocation forever).
- PLAN_AGENTIC_SERVICES: every instrument 'ask' → 'deny' (subThreadDelegation,
  canvasInteraction, sketchCanvas, meshCanvas, mediaEditing, canvasEval,
  webBrowsing) — Plan never prompts; keep externalPublish/mcpTools per the
  no-ask rule ('deny'), BUT keep the plan-artifact fileChanges carve-out (lives
  in the executor, not this map — verify, don't widen).
- Grant-immunity holds: PLAN_APPROVAL_ONLY_INSTRUMENT_SERVICES /
  READ_ONLY_APPROVAL_ONLY_INSTRUMENT_SERVICES + `isPlanInstrumentGrantHold`
  (both gate sites: requestAgenticServiceApproval ~7475 and
  resolveNativeApprovalPreflight ~7138) must swap roles: the hold now protects
  read_only's ask surface (every asked service), while plan needs a hard-deny
  path instead. Rename carefully — the gate folds this into neverAutoAllow.
- `PRESET_AUTHORITY_RANK` (RerouteFailoverPosture.ts): re-scale so plan(0) <
  read_only(1) < default(2) — Plan becomes the strict floor. Audit every
  consumer for downgrade direction.
- `READ_ONLY_ROUND_PERMISSION_PRESET_SET` (EnsembleRosterMutation.ts): its job
  is "mid-round swap can't unlock instruments" — after inversion the unlockable
  surface moves to read_only, so the set membership must be re-derived from the
  new lattice (likely {'plan'}), with the regression test rewritten from intent,
  not membership.
- `isReconRunPosture` (ReconPosture.ts) stays presetId==='read_only' exact, but
  every consumer that ASSUMED "recon ⇒ nothing can prompt" must be re-audited
  (grep isReconRunPosture call sites).
- Prompt steers: PromptComposition recon steer + EnsemblePrompt permission-role
  lines + OllamaHarnessGates + OllamaToolsDoc access vocabulary ("denied under
  Ask/Plan" becomes "asks under Ask / denied under Plan") + regenerate
  resources/Tools.md.
- Providers that PHYSICALLY run read postures in native plan mode (Grok/Cursor
  `--mode plan`, safe-subset advertise keyed off approvalMode) cannot execute
  what the modal approves for NATIVE tools — asks only apply to
  TaskWraith-brokered tools there; document per-provider truth in the tool docs
  rather than pretending uniformity.

### D — LANDED 2026-08-04 (`dcc96942e`) — shell tier policy + codex posture gate
Built as ShellCommandTierPolicy.ts (both polarities documented in-module) +
holds folded into `neverAutoAllow` at both gate sites + the inspection fast
path (ls/cat/grep-class prompt-free under ask policies, audit reason
`inspection_shell`) + `codexNativeAutoApprovalFromPosture` (codex native gate
honors the signed post-clamp posture; global deny survives). Deliberate
residue: shellCommands stays promptable at Accept Edits for everything beyond
the inspection allowlist (a general "non-destructive" blessing of build
commands is unsound — `npm run` executes arbitrary scripts); process-mutation
holds ask each time at Full WS Access (stricter than the ask-once spec until a
narrower grant key exists); compound/wrapped commands evade the holds (#54
residue); the codex exec-fallback setup guard keeps reading globals (no run
posture exists at provider-setup time).

Original notes: destructive-shell ask + ask-once native consent
- Non-destructive vs destructive shell needs a CLASSIFIER before
  shellCommands can move to 'allow' at default — none exists today (the
  read-only git fast-path classifier is the nearest prior art). Until it
  exists, shell keeps prompting at default; do NOT ship shellCommands:'allow'
  here without it.
- "Ask once for provider-native tools on first call": per-provider consent
  memory (mirror the AntiGravity consent-wall pattern); codexNeedsApprovalGate
  currently reads GLOBAL settings, not run posture — fold into this slice.

### E — LANDED 2026-08-04 (`dcc96942e`) — external-read split + rm/remote rules
Outside-workspace READS auto-approve (audited, reason `external_read`) at
workspace_write/full_access on both gates; writes keep the external-path grant
card. `rm -r`-class asks everywhere except provably in-workspace targets at
Full Access ("always approve in workspace" — proof fails closed on `..`, `~`,
globs, absolute escapes, or missing workspace). Remote/SSH + raw network shell
(ssh family, curl/wget/nc, remote rsync) asks at EVERY tier per the owner
spec — note the deliberate UX cost: `curl` in builds now prompts at the write
tiers. rm -rf githook interplay resolved at the gate (git has no hook that
fires on rm; the approval gate is the only sound seam).

Original notes:
- Outside-workspace READS auto at workspace_write+ (today external-path grants
  prompt for reads too — split read vs write in the external-path decision).
- rm -rf githook interplay: the block lives in .githooks + shell approval
  preview; add the inside-workspace auto-approve exemption for full_access only.
- Remote/SSH + remote-network ASK classes: no such classification exists today
  (networkAccess is a blunt gate); needs a shell-command/host classifier —
  design before promising.

## Residue shared with the Isolate hold (99516962c)
`neverAutoAllow` holds surface as plain approval cards (exact command +
ensemble context; audit trail carries the disposition) with no hold-specific
reason line. If a reason-surface is ever built for these holds, both the
widened read_only (Ask) grant-hold and the Isolate pinned-Shared branch hold
want a line naming WHY the prompt fired.

## Open items to re-confirm with Chris before slice C ships
- The spec's per-tier tool tables are non-monotonic in places (e.g. the Accept
  Edits list omits Launch/Canvas/Mesh/IDE sections its prose auto-approves;
  browser_click sits in the Ask tier). Treat the SEMANTICS above as authority,
  re-derive the tables from the service map, and review the generated
  Tools.md diff with Chris.
- Whether Ask's modal may also be answered by Boss/Captain auto-approval
  (bossman lane) or user-only.
