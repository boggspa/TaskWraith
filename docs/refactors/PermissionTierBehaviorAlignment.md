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

### C — Ask/Plan ask-semantics inversion (the core; biggest blast radius)
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

### D — Accept Edits: destructive-shell ask + ask-once native consent
- Non-destructive vs destructive shell needs a CLASSIFIER before
  shellCommands can move to 'allow' at default — none exists today (the
  read-only git fast-path classifier is the nearest prior art). Until it
  exists, shell keeps prompting at default; do NOT ship shellCommands:'allow'
  here without it.
- "Ask once for provider-native tools on first call": per-provider consent
  memory (mirror the AntiGravity consent-wall pattern); codexNeedsApprovalGate
  currently reads GLOBAL settings, not run posture — fold into this slice.

### E — Full WS / Full Access refinements
- Outside-workspace READS auto at workspace_write+ (today external-path grants
  prompt for reads too — split read vs write in the external-path decision).
- rm -rf githook interplay: the block lives in .githooks + shell approval
  preview; add the inside-workspace auto-approve exemption for full_access only.
- Remote/SSH + remote-network ASK classes: no such classification exists today
  (networkAccess is a blunt gate); needs a shell-command/host classifier —
  design before promising.

## Open items to re-confirm with Chris before slice C ships
- The spec's per-tier tool tables are non-monotonic in places (e.g. the Accept
  Edits list omits Launch/Canvas/Mesh/IDE sections its prose auto-approves;
  browser_click sits in the Ask tier). Treat the SEMANTICS above as authority,
  re-derive the tables from the service map, and review the generated
  Tools.md diff with Chris.
- Whether Ask's modal may also be answered by Boss/Captain auto-approval
  (bossman lane) or user-only.
