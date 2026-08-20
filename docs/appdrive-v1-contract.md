# AppDrive V1 — retrospective shipped contract

**Contract date:** 2026-08-20  
**Status:** Shipped boundary, recorded retrospectively after the implementation reality pass  
**Design history:** [appdrive-design.md](appdrive-design.md)

AppDrive lets an agent drive an application only through a surface TaskWraith
owns or has attached through its explicit managed-window flow. It is a QA and
preview capability, not general desktop control. This document defines the V1
behavior callers and reviewers may rely on.

## 1. Shipped surfaces

| Surface | V1 scope | Mutating verbs |
| --- | --- | --- |
| Web Canvas | TaskWraith Canvas Browser, including any HTTP(S) origin in its persistent browser profile | `click`, `fill`, allowlisted non-text `key`, `scroll`, `hover`, `select` |
| Simulator Canvas | One exact Simulator UDID plus current app bundle when known | open, boot, install, launch, terminate, hardware button, rotate, normalized tap, type, scroll |
| Managed native window | One live macOS window proved to belong to the current Run launch and selected through Screen Watch + View & Control consent | AX-ref-only `click` and `fill` |

Read operations do not consume action steps. Web observation includes snapshot,
screenshot, inspect, network, console and bounded `wait_for`. Simulator
observation includes screenshot and the truncated accessibility tree. Managed
native observation is AX-first snapshot/inspect plus safety-screened capture.

The web contract is intentionally **any-origin** and uses the persistent
`persist:taskwraith-canvas-browser-v1` profile. V1 does not claim a loopback
fence or cookie isolation. Consent and consequential-action controls are the
security boundary for authenticated pages.

## 2. Authority and leases

A web or Simulator mutation needs a live `AppDriveLease` for the exact:

- surface and surface kind;
- chat, Run, provider and optional Ensemble participant;
- allowlisted verb set;
- user-approved expiry and step budget.

Only an explicit user decision or an exact surface session grant created by a
prior user decision can mint the lease. Policy, YOLO mode, Boss authority and
agent prose cannot mint one. A one-off approval gets one step. A session lease
defaults to 20 steps and 15 minutes; implementation ceilings are 100 steps and
30 minutes.

Navigation, surface close, human takeover, Run/chat termination, expiry, budget
exhaustion, replacement and user revocation end authority. Transfer preserves
the same human approval while changing the exact Run, provider and participant;
the target must satisfy the existing Boss/Captain transfer rule when an
Ensemble roster is present.

Managed native windows use their stricter native lease plus the Foreground Drive
session overlay. The window must still match the launch PID ancestry and process
birth identity at every operation. Pause, takeover, stop, expiry or budget
exhaustion refuses new actions.

## 3. Observe → act → verify

V1 is one action at a time:

1. Observe the surface and retain its freshness fields.
2. Propose one structured action against that observation.
3. Execute once and inspect `executed`, `refusalReason` and `verified`.
4. Re-observe the postcondition.
5. Record the verdict with `canvas_drive_verify`; do not retry an unchanged,
   stale or indeterminate action blindly.

`canvas_drive_report` returns the bounded report/action IDs. A post-action
`canvas_snapshot`, `simulator_screenshot`, or `simulator_inspect` returns a
value-free `driveObservation` receipt. Pass its `observationId`, `surfaceId`,
`reportId` and `actionId` to `canvas_drive_verify`. Supply `driveActionId` to
the observation tool when verifying an earlier action rather than the most
recent completed action.

The receipt is issued by the trusted observation path and binds the exact chat,
observer, report, action and surface. Another participant cannot reuse it.
`changed`, `unchanged` and `unknown` remain distinct: changed is surface-confirmed,
unchanged is not verified, and unknown is inconclusive.

## 4. Actor/verifier split

The user can request `requireIndependentVerifier` when approving a leased web or
Simulator action. That choice persists on the lease, and an individual action
may also opt into the stronger rule. The action remains pending until a
different Ensemble participant obtains its own trusted post-action observation
receipt and attests the verdict.

Managed native actions are treated as consequential: every click has its
separate human confirmation and every action requires the native driver’s next
observation. A second participant may add an attestation, but the shipped native
window lease is Run/provider-bound and does not claim participant-required mode.

Action completion is bound to the original actor even if the lease transfers or
ends while an operation is in flight. A new holder cannot settle the previous
actor's action.

## 5. Consequential and secret-bearing actions

- Web controls whose page-authored label matches the narrow irreversible or
  financial predicate require an additional person-at-keyboard confirmation.
- Every managed-native click requires a content-bound, one-use confirmation and
  a strict pre-dispatch audit claim.
- Credential fields are human-only. Password, one-time-code and equivalent
  fields refuse `fill`; callers must not route around that refusal with eval,
  coordinates or another verb.
- Typed values, page labels, URLs, page text, approval IDs, handles, PIDs,
  process receipts and screenshot bytes never enter the drive-session report.

These controls mitigate judgment errors; they do not prove that a page label is
truthful or that a confirmed business action was wise.

## 6. Report contract

Reports are process-local, capped at 128 sessions and 100 actions per session.
They contain surface identity/kind, actor and optional verifier identity,
timing, expiry, budget, verbs, dispatch outcome, verification state and terminal
reason. Expiry is evaluated mechanically when reports are read. Ending a
session settles pending work as indeterminate rather than leaving an apparently
active or silently successful record.

Observation receipts are bounded, one-use for successful attestation, and are
not included in report history. Reports remain queryable after revocation long
enough to explain the terminal state, subject to the process-local cap.

## 7. Refusal and retry rules

`executed: false` means no input was dispatched. Stale target, stale input
epoch, occlusion, missing target, secret field, human activity, expired lease,
budget exhaustion, binding mismatch and missing confirmation are terminal for
that attempted action. Re-observe and re-plan; never repeat the same action just
because the UI did not visibly change.

`verified: unchanged` is not proof of failure: async navigation or rendering may
settle later. It is deliberately recorded as not verified until a trusted later
observation supplies a verdict. A transport failure after dispatch is
indeterminate and must not be retried automatically.

## 8. Explicitly outside V1

- arbitrary desktop/window attachment or background control;
- drag, right-click, double-click, file upload and multi-action batches;
- arbitrary key codes or general keyboard text injection on web;
- native selectors, coordinates, CGEvent/pixel input, keyboard, eval, network,
  console, reload, resize, annotation or sketch control;
- ambient access based only on knowing a canvas ID, UDID, bundle ID or window;
- silent Boss/Captain inheritance after failover;
- a claim that authenticated web sessions are disposable or cookie-free.

Any expansion of those boundaries is AppDrive V2 work and requires a new
product/security decision rather than an implementation convenience.
