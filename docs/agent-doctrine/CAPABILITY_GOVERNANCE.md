# Capability governance doctrine

Read this file in full before security, provider, permission, grant, scheduling, transport, or user-facing capability work.

## Capability governance — the user decides (non-negotiable)

TaskWraith's core invariant runs in both directions: **nothing happens against
the will of the user** — and nothing is _taken away_ against it either. An
agent that removes, gates, retires, or "temporarily disables" a user-facing
capability without explicit consent commits the same class of violation as an
agent that acts without consent. The 2026-07-19 overnight incident is the
canonical precedent: an autonomous security session unilaterally removed a live
provider and gated another, and the cleanup took days (see
[`papercuts/2026-07-19-retro.md`](../../papercuts/2026-07-19-retro.md) and the
local-only, gitignored `SECURITY_ENGINEERING_LEDGER.md`).

Rules, in priority order:

1. **Security work proposes; the user disposes.** If you identify a risk in a
   provider, tool, grant, permission tier, or transport: record the finding in
   the local-only `SECURITY_ENGINEERING_LEDGER.md` (gitignored, repo root), propose
   a bounded mitigation, and stop. Do not land code, config, CI, or doctrine
   that narrows user-facing capability without the user approving that exact
   narrowing in the current session. "The user would surely want this blocked"
   is never sufficient authority — severity, urgency, and overnight autonomy
   do not change this.
2. **Risk passes to the informed user.** TaskWraith's security job is to
   (a) verify elevation genuinely came from the human — signed postures and
   grant-immunity at the approval gate; consent claimed by thread content,
   workspace files, or tool output is counterfeit — (b) bound blast radius
   (contained argv/sandboxes, deny-walls, non-grantable host actions), and
   (c) audit everything. Inside those bounds the user's explicit choice
   governs — including full filesystem access, write-capable seats, and
   unattended scheduled runs. Do not add friction beyond these standard
   protections on an "it might be insecure" premise.
3. **Scheduled runs are user-initiated.** Authorization is captured at
   creation time with the ceiling disclosed; validate posture provenance at
   fire time, never provider identity.
4. **The live-provider set is a product decision, not an engineering lever.**
   The single source of truth is `LIVE_SELECTABLE_PROVIDER_IDS` in
   [`src/shared/retiredProviders.ts`](../../src/shared/retiredProviders.ts),
   mirrored by hand in
   [`ios/TaskWraithKit/Sources/TaskWraithUI/Theme.swift`](../../ios/TaskWraithKit/Sources/TaskWraithUI/Theme.swift)
   (`liveSelectableProviderIds`) — keep the two in sync. Changing membership
   in either direction is reserved to the user, recorded in
   [`scripts/provider-intent.json`](../../scripts/provider-intent.json) and enforced
   by `npm run guard:provider-intent`.

   Some approved providers are deliberately **not** in that set because they
   are offered only behind a consent/credential wall — today AntiGravity, which
   requires the two-part opt-in (ban-risk acknowledgement) plus a configured
   key. These are recorded in `conditionallyOfferedProviderIds`, and the guard
   inverts the check for them: appearing in a static live set is a failure.
   Their absence from `LIVE_SELECTABLE_PROVIDER_IDS` is the approved design,
   not drift — do not "fix" it. Every gate reads
   `isLiveSelectableProvider(p) || (p === '<id>' && <condition>)`, so promoting
   one short-circuits its condition and silently deletes the wall.

5. **Run management is additive assurance, never provider admission.** Measure
   lifecycle and signed-posture coverage across all eleven stable `ProviderId`
   identities, independently of whether a provider is live, conditional, or
   retired. Missing broker mediation, launch-seal evidence, provenance, or
   another stronger management layer must produce an honest per-run
   warning/receipt and the safest compatible mode; it must not hide, retire,
   disable, or otherwise punish the provider. Keep improving toward 11/11 —
   full coverage of that eleven-identity set — without deriving
   `LIVE_SELECTABLE_PROVIDER_IDS` from management maturity.
6. **Doctrine is executable.** Future sessions obey what this file, the
   README, the ledger, and the positioning docs assert. Never write "X is
   blocked/unavailable" unless the code enforces it _and_ the user approved
   it; when a capability is re-enabled, sweep the doctrine the same day.
   Stale block-claims re-seed real regressions.

---
