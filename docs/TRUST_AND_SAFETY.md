# Trust and Safety

<p align="center">
  <img src="../design-assets/ghost/ghost-guy-mark-monoline.svg" alt="TaskWraith monoline mark" width="72" />
</p>

TaskWraith keeps its own work records on your computer, but it can still
coordinate powerful tools against a developer machine. Treat it like a shell,
editor, git client, browser automation surface, and remote-control bridge in one
app: start with low-risk work, inspect what it asks for, and only widen trust
after the behavior is boring and understandable.

This page is written for cautious users deciding whether to try the app on a real
workspace. Engineering guardrails are also documented in [SAFETY.md](SAFETY.md)
and [SECURITY.md](../SECURITY.md).

## Current Maturity

TaskWraith is a young public project with a small adoption footprint. The source
is public and the release pipeline has security checks, but there has not yet
been enough independent usage, third-party review, or enterprise deployment to
make "many people use it" a substitute for your own evaluation.

Recommended posture:

1. Try a scratch repository first.
2. Run in Ask or Plan workflow first.
3. Review the activity log, approval ledger, and generated diffs.
4. Move to meaningful workspaces only after several low-risk sessions behave as
   expected.

Plan workflow is distinct from Ask. It still uses a read-only
execution posture for ordinary provider tools, but it can save a narrow markdown
plan artifact under a validated workspace path so you can approve or edit that
plan later. It does not allow arbitrary file edits, shell commands, or other
mutating tool calls.

TaskWraith is not yet a complete managed-enterprise product. Current managed
policy and audit-export work does not include SSO, SCIM, SIEM integration, WORM
or append-only audit export, organization-wide retention, or a full MDM/org
control plane.

## Trust Model

TaskWraith's authority is centered on the desktop app:

- The desktop main process owns workspace selection, transcript writes, approval
  prompts, run state, local history, remote-pairing records, and provider
  dispatch.
- Provider CLIs, SDKs, and local-model harnesses run only after you configure or
  authenticate those tools separately. TaskWraith does not bypass provider
  accounts, quotas, terms, or provider-side logging.
- TaskWraith can gate the tools it brokers, but it is not a universal operating
  system sandbox. Provider-native behavior varies by provider and transport.
- Local transcripts, raw events, tool output, generated artifacts, and exported
  diagnostics can contain sensitive data. Display redaction is best effort, not
  a guarantee that secrets never exist on disk.
- Optional remote and collaboration features are designed around explicit
  pairing, allowlists, end-to-end encryption, and host-side authority. Live
  Activity display state is the disclosed exception to ordinary remote E2EE.
  These surfaces still expand the attack surface and should be enabled
  deliberately.
- **A model never states a number about its own run.** Close-out summaries
  split qualitative prose from quantitative fact: counts, durations and token
  totals come only from an app-computed `CloseoutReceipt`
  (`src/shared/closeoutReceipt.ts`) built from TaskWraith's own structured
  records, never from model text. Any generated close-out narrative containing
  a numeral — digits or spelled-out words — is rejected rather than trimmed.
  This protection shipped in **v1.9.6**. The source-ahead checkout may extend
  the same boundary, but the receipt-backed rule itself is part of the current
  public baseline.

  The rejection is enforced independently at each layer that can produce or
  render such prose, so no single bypass silently reinstates a model-authored
  count: the shared guard `closeoutNarrativeHasAuthoredNumeral`; the main
  process (`src/main/CloseoutSummarizer.ts`, "Foundation Models returned a
  quantitative claim reserved for the app-owned receipt"); the Swift daemon,
  which instructs Apple Foundation Models not to emit numbers *and* backstops that
  instruction in code rather than trusting it; and the renderer, which drops a
  non-conforming summary and falls back to a deterministic line. The reason to
  read this as a trust boundary rather than a formatting rule: a count a model
  asserts about its own work is unverifiable, and the telemetry it reads to
  produce one is attacker-influenceable.

The tagged v1.9.6 release is the current public baseline. This repository can
also contain source-ahead work that is not a released guarantee until it is
named in later release notes. The changelog's **1.9.6** section is the newest
released section; anything in this tree beyond it is source-ahead and carries
no released guarantee.

## Safe First Run

Use this path when evaluating TaskWraith for the first time:

1. Create or clone a disposable repository.
2. Open that repository as the selected workspace.
3. Use a provider you already trust and understand.
4. Pick Ask or Plan workflow. Avoid full-workspace, yolo,
   auto-edit, or broad session grants.
5. Ask for a non-mutating task, such as "summarize the project layout" or "find
   likely test entry points."
6. Inspect the Activity view and Raw Events. Confirm the provider only read what
   you expected.
7. Ask for a small edit in a throwaway file. Review the Diff Studio result before
   committing anything.
8. Open Settings → Automation → Approvals & Grants after the run.
9. Only then try a real project, still avoiding broad grants until the workflow
   has earned your trust.

Leave these disabled during first-run testing:

- iOS or remote-device pairing.
- Channels / shared-chat invites.
- Screen Watch and attached-window capture.
- Canvas/browser automation.
- Creative-app AppleScript automation.
- Full-workspace or unattended workflow grants.

When you are ready to enable optional surfaces, see
[ADVANCED_OPTIONAL_SETUP.md](ADVANCED_OPTIONAL_SETUP.md) for the external steps
around Ollama models, API keys, iOS/Tailscale pairing, Screen Watch, creative
apps, and custom MCP servers.

Managed Cursor signs in normally and can work as a solo, Ensemble, delegated,
or delegating seat. Its TaskWraith-mediated calls use the selected policies,
approval records, and workspace Tool Grants; Cursor-native tools and
account/project MCP remain provider-owned and sandbox-bounded. Treat that native
sandbox as an honest partial backstop — not a full egress or
workspace-under-`$HOME` seal. See `SECURITY_ENGINEERING_LEDGER.md`
(TW-SEC-2026-003) for the transport details; it is local-only, intentionally
gitignored, and not published.

## Capability Matrix

| Surface                            | Default posture                                                                                   | What it can access                                                                                                                                                                                                                                                | What may leave your computer                                                                                                                                                                     | Approval and audit                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider runs                      | User starts a run in a selected chat/workspace.                                                   | Prompt text and any provider-visible transcript/tool context. Qualified workspace-aware seats may access selected-workspace context. Managed Cursor can use both its native tools and TaskWraith's governed tool gateway.                                         | Anything sent to the chosen provider CLI/API according to that provider's behavior.                                                                                                              | Provider/tool approval cards and run events are stored locally for TaskWraith-mediated calls. Provider-native actions remain inside that provider's own trust and audit boundary.                                                                                                                                                                                         |
| Workspace reads/search             | Scoped to the selected workspace where the adapter can enforce it.                                | File names and file contents in the selected workspace for qualified tool-capable seats.                                                                                                                                                                          | File snippets may be sent to the active provider as context.                                                                                                                                     | Activity rows and raw provider events are retained.                                                                                                                                                                                                                                                                                                                       |
| Work Projects                      | User-created persistent workspace groups.                                                         | Scoped to selected project resources (workspaces, extracts, files) and metadata entries.                                                                                                                                          | Extracted context may be sent to providers when a Project is active.                                                                                                                             | Consentful Extracts enforce read-only bounds. Keepables and Ensemble Use-next states do not grant execution authority or bypass tool gates.                                                                                                                                                                                                                               |
| Plan workflow                      | User-selected Plan preset.                                                                        | Workspace context needed to draft a plan, plus a validated markdown plan artifact path when the proposed-plan flow saves one.                                                                                                                                     | Plan content may be sent to the active provider and stored locally as the plan artifact.                                                                                                         | The markdown-plan write is product-managed; other mutating tools remain blocked until approval or a higher permission posture.                                                                                                                                                                                                                                            |
| File edits and Diff Studio         | Mutating edits require an edit-capable mode or explicit approval.                                 | Files in the selected workspace, plus user-approved external paths where supported.                                                                                                                                                                               | Diffs/content may be visible to the active provider.                                                                                                                                             | Diffs are reviewable before commit; approvals are ledgered.                                                                                                                                                                                                                                                                                                               |
| Shell and git                      | Approval-gated unless the selected provider mode grants more authority.                           | Commands run in the workspace context; git status/diff/commit surfaces.                                                                                                                                                                                           | Command output can be sent to the provider and stored in local history.                                                                                                                          | Command approvals, auto-denies, and run events are auditable.                                                                                                                                                                                                                                                                                                             |
| Local Ollama tools                 | Same permission presets as other providers; run profiles tune local prompting/runtime behavior.   | The TaskWraith tool surface where local capability exists, limited by permission posture and network policy.                                                                                                                                                      | Local model prompts stay local unless you use Ollama-hosted/cloud models or other network tools.                                                                                                 | Standard run permission posture and approvals apply; there is no separate safety-tier ladder.                                                                                                                                                                                                                                                                             |
| Ensembles, sub-threads, audits     | User-created or explicitly delegated.                                                             | The transcript and provider-qualified context available to each runnable participant. Managed Cursor can be a solo seat, Ensemble participant, delegated child, or delegating parent when its TaskWraith gateway is active. In source-ahead builds, main validates exact picker identity and rejects ambiguous plain direct mentions. | Each cloud participant may receive transcript/context needed for its turn.                                                                                                                       | Participant runs, audit findings, and delegation events are recorded locally.                                                                                                                                                                                                                                                                                             |
| Workflows and scheduled runs       | User-defined. Unattended elevation requires explicit acknowledgement.                             | The workspace and tools allowed by the workflow template.                                                                                                                                                                                                         | Same provider exposure as a normal run, repeated by schedule.                                                                                                                                    | Workflow history, approvals, and run state are persisted.                                                                                                                                                                                                                                                                                                                 |
| Transcript sky and weather visuals | Network lookup runs only while sky visual FX are enabled; disabling the FX stops weather polling. | The host's public-IP-derived approximate location and current weather conditions. No task, transcript, or workspace content is used.                                                                                                                              | The public IP is visible to `ipapi.co`, with `ipwho.is` as fallback. Open-Meteo receives the rounded coordinates (0.1°, about 11 km) and, like any direct web service, the request's source IP.  | The last coarse location and weather snapshot are cached locally in `host-weather-cache.json`; this automatic visual lookup does not use the agent approval flow.                                                                                                                                                                                                         |
| iOS remote bridge                  | Disabled until paired. Live Activities are on by default where supported, with Mac and iOS off switches. | Read-only projections by default; selected actions only through Mac policy. Live Activities receive only the separately allowlisted coarse display state.                                                                                                         | Relay and ordinary APNs alerts may expose routing/status metadata, not task content. ActivityKit Live Activity state is readable by Apple and is limited to coarse phase/time/counts, provider/seat states, layout/colours, and an opaque per-activity reference. | Pairing, allowlists, approvals, expiry, and replay checks are enforced on the Mac. No privacy-sensitive value may ever be seeded into Live Activity state; expanding the allowlist requires a fresh privacy/security review.                                                                                                                                                |
| Channel members                    | Host-created Channel invite per shared chat.                                                      | Least-privilege projection of one shared chat; member messages enter the host's review queue.                                                                                                                                                                     | Projection/message frames travel over the channel transport, encrypted end to end.                                                                                                               | Host remains authority for transcript writes; member messages release into Channel history only after host approval, never enter the chat transcript, and cannot reach the AI unless the host sends them.                                                                                                                                                                  |
| Screen Watch / attached windows    | Off until the user attaches a window.                                                             | Frames from the chosen window, one frame at a time.                                                                                                                                                                                                               | Captured frames may be sent to the active provider as visual context.                                                                                                                            | Attachment and downstream tool actions are surfaced in the run.                                                                                                                                                                                                                                                                                                           |
| Canvas/browser-like tools          | Optional advanced surface. The first permitted `canvas_eval` on a live surface asks on desktop; accepting opens a 12-hour window for that canvasId across navigation and later turns. | The page or preview surface you expose to the agent. Other Canvas surfaces are outside an eval window, and an app restart ends it. | URLs, page content, screenshots, actions, scripts, and direct tool results may reach the provider depending on the tool. Provider assistant prose may echo scripts/results into the persisted transcript. | High-risk actions remain policy-gated. Every `canvas_eval`, including a window auto-approval, retains an approval-bound digest/length/outcome receipt rather than script/result content; compatibility rows are content-redacted. The digest is correlation/integrity metadata, not encryption. |
| Creative-app automation            | Off unless configured and approved.                                                               | Supported app state and AppleScript automation targets such as Final Cut Pro or Logic Pro.                                                                                                                                                                        | App snapshots or command results may be sent to the provider.                                                                                                                                    | AppleScript dispatch is approval-gated and logged.                                                                                                                                                                                                                                                                                                                        |
| Discord context                    | Off unless a bot token/server is configured.                                                      | Recent messages from configured Discord channels the bot can read.                                                                                                                                                                                                | Channel context is attached to provider prompts as untrusted context.                                                                                                                            | Read-only; TaskWraith does not post back to Discord through this feature.                                                                                                                                                                                                                                                                                                 |
| Media and image tools              | User/provider initiated.                                                                          | Transcript media, generated images, selected audio/video files, and decoded frames.                                                                                                                                                                               | Media-derived context may be sent to providers or external generation APIs you configure.                                                                                                        | Media refs use trusted channels; generated artifacts remain reviewable locally.                                                                                                                                                                                                                                                                                           |
| Usage, observation, and diagnostics | Usage/diagnostics stay local by default. First-party product observation remains off until the user makes the affirmative first-launch or Privacy-settings choice. | Provider usage summaries, app status, crashes, and diagnostics exports. An enabled daily report contains only UTC day, app version, OS family, processor family, and release channel; volatile presence uses a random process-only lease.                          | Diagnostics leave only when exported/shared. If observation is enabled and an endpoint is configured, the fixed daily report and short-lived presence lease reach that endpoint; no work content or stable install id is sent.                                | Observation can be withdrawn without losing app functionality. The receiver exposes presence only as a current aggregate count and does not retain lease values, events, durations, or session history.                                                                                                                                                                     |

## Emulator Canvas: a bounded demo surface

**Source-ahead only:** this describes code in the current repository after the
public v1.9.6 baseline. It is not a release or packaged-artifact promise.

Emulator Canvas runs one reviewed, packaged homebrew demo. It is not a general
ROM loader or browser: neither a person nor an agent supplies a game file, ROM
path, URL, raw memory address, or cheat command. The available agent workflow
is deliberately narrow:

1. An agent reuses an attached live emulator `canvasId` when one exists;
   otherwise `emulator_open` creates a chat-owned Canvas for that fixed demo.
2. `emulator_observe` returns one atomic PNG frame and safe mapped state with an
   opaque observation token. The structured result does not expose raw RAM,
   ROM bytes, internal URLs, or base64 pixels.
3. `emulator_step` must name that exact Canvas and the most recent observation
   token. It can request only bounded controller segments; the result says
   whether the requested frames completed, were refused, or were interrupted.

When a live emulator Canvas is already attached, the agent reuses that
`canvasId` and begins with observation rather than opening a duplicate session.

An agent may step only with an exact-surface Canvas/AppDrive approval or grant;
that consent does not cover every Canvas in a chat or workspace. You can play
directly at any time. A human play loop makes agent control stand down, and the
exact surface authority is revoked rather than transferred to another Canvas.
Pixel observations can be sent to the active provider as visual context, so use
the same care you would for any other Canvas screenshot.

The Inspector Canvas dock and Thread Home are separate entry points for the
same fixed demo. Thread Home uses a full Multiview pane and has no separate
pop-out. For a session already open in the Inspector Canvas dock, **Pop Out**
and **Dock** reparent that active dock session; they do not restart it or
broaden its agent authority. See [Emulator Canvas](how-to/canvas-and-previews/emulator-canvas.md) for the user workflow.

## What Data Stays Local

TaskWraith stores app state in Electron's `userData` directory. On macOS this is
normally:

```text
~/Library/Application Support/TaskWraith
```

Common local state includes:

- `settings.json` and workspace records.
- `chats/` transcript files.
- `run-events/` durable run-event logs.
- Usage summaries, approval ledger records, workflow state, goals, and audit
  state.
- `host-weather-cache.json`, containing the last coarse location and weather
  snapshot used by the optional transcript sky visuals.
- `kimi-acp-seats-v2/`, containing current durable native Kimi Code ACP seat
  checkpoints used for provider-session continuity and recovery.
- `bridge/` pairing records, remote workspace allowlists, and APNs routing token
  records.
- Live Activity per-activity and push-to-start tokens are deliberately absent
  from that directory: they remain only in the running Mac process and are
  discarded when their activity/device is forgotten or TaskWraith exits.
- `human-collaboration.json` and the local collaboration identity record when
  collaborator features are used.
- Transcript media assets, media staging, Canvas state, and generated artifacts.

History created by v1.8.4 or an earlier source checkout can contain the exact
`canvas_eval` script in a durable approval/run-event payload. Source-ahead
hardening does not destructively rewrite old hash-chained history. Treat that
existing history as sensitive. In the source-ahead checkout, **Settings →
General → Delete all chat history** removes chats, run-event history, the
approval and feedback ledgers, execution-graph history, sub-thread mailboxes,
Canvas workspaces/artifacts, Kimi seat state, and the bridge subprocess log. It
does not remove provider-native history or provider credentials. In v1.8.4, the
same control removed chats and run events but did not remove the separate
approval ledger. For complete removal, quit TaskWraith and move or delete its
`userData` directory as described below; moving it aside keeps a recoverable
backup.

TaskWraith does not store provider account passwords in the repository. Provider
CLIs and SDKs keep their own credentials wherever those tools normally store
them. Remote bridge identity material is protected with Electron `safeStorage`
where available.

To reset TaskWraith's local state manually, quit the app and move or delete the
`userData` directory above. On macOS, also remove or move
`~/Library/Logs/TaskWraith/bridge-subprocess.log`, which lives outside
`userData`; the source-ahead in-app history action clears this log for you. To
keep a backup, move paths aside rather than deleting them. Provider CLI
credentials may remain in the provider's own config locations.

## What Can Leave the Machine

TaskWraith is not air-gapped. Data can leave your computer when you choose a
feature that necessarily talks to another system:

- Cloud provider runs send prompts, selected context, tool outputs, and sometimes
  files or diffs to that provider.
- Provider CLIs may maintain their own logs, caches, telemetry, or remote
  sessions outside TaskWraith.
- Web search/fetch, browser, Canvas, image-generation, and media-analysis tools
  can contact external services depending on configuration.
- While transcript sky visual FX are enabled, TaskWraith requests approximate
  location from `ipapi.co` and falls back to `ipwho.is`; those services can see
  the host's public IP. TaskWraith rounds the returned coordinates to 0.1°
  (about 11 km) before requesting current conditions from Open-Meteo.
  Open-Meteo receives those rounded coordinates and the request's source IP.
  No task, transcript, file, or workspace content is sent in this flow.
- Discord context reads from Discord through your configured bot token.
- iOS bridge and collaborator transports use relay/routing infrastructure.
  Remote task projections, collaborator frames, and optional richer alert
  content stay end-to-end encrypted; ordinary APNs alerts expose only routing
  and coarse status metadata. Live Activity attributes/content state are the
  explicit exception because ActivityKit must decode them. Apple can read only
  the strict allowlist of phase/time/counts, provider and bounded seat states,
  layout/colour values, and an opaque per-activity reference. No
  privacy-sensitive value—including task/workspace content or a
  workspace/account-linkable identifier—may ever be seeded into that state.
- If the user affirmatively enables first-party product observation and the
  build has an endpoint, a fixed no-content daily report and a random
  process-only presence lease can reach that endpoint. The complete field and
  retention contract is in [PRIVACY.md](PRIVACY.md); neither path sends a
  stable installation id or workspace/task content.
- Diagnostics exports are local files until you share them.
- Approval-ledger, audit-bundle, and diagnostics exports are local files until
  you share them. Approval exports can include request bodies, command previews,
  file paths, prompts, metadata, and decision notes, so treat them as sensitive.

If a workspace contains secrets, customer data, unreleased product code, or
regulated data, assume any provider-visible prompt or tool result may become
provider-visible data.

## Release and Build Verification

For source builds:

```sh
npm ci
npm run security:deps
npm run typecheck
npm run test
```

For release work, the repository includes:

```sh
npm run validate:release
npm run build:mac:notarized
npm run security:sbom
```

Run release verification on the exact commit/tag candidate that will be built
and published, and build every artifact from that same candidate. Shipping the
candidate tip does not replay its intermediate commits, so backlog age or commit
chronology is not a release order. If a fix is backported or cherry-picked,
select a dependency-closed slice and rerun the full candidate checks after the
pick.

The source-ahead provider permission-conformance canaries are an additional
explicit lane, not a substitute for normal CI. Probe-only output records binary
versions, digests, and capability fingerprints without model calls; it is
inventory, not live permission evidence. A credentialed
qualification-candidate run rejects missing/skipped required checks but may
record an unknown binary as
`unattested_pass`; that is evidence to review, not a trusted or releasable
fingerprint. Strict release mode additionally rejects unknown fingerprints.
Signed release jobs accept only an exact-commit successful release canary that
completed within the preceding 24 hours; stale, future-dated, or malformed
attestations fail closed. Run that canary immediately before creating the tag.
Signed publication also stays blocked until the repository declares its `v*`
tag ruleset and immutable-release controls commissioned. Both platform
publishers re-resolve the remote tag to the checked-out commit immediately
before release creation and upload; external no-bypass tag/release controls
remain necessary to close administrator race windows.
Publisher reruns do not trust a previously completed dependency job: immediately
before release mutation, each platform rechecks both commissioning variables and
repeats the exact-commit, 24-hour provider-attestation query.
The coverage command produces a measured, non-gating baseline; there is no
percentage threshold or PR coverage ratchet.

```sh
npm run verify:provider-compatibility
npm run verify:provider-permissions:live
npm run test:coverage:baseline
```

The reviewed live-test allowlist includes Kimi's ACP containment suite and
Cursor's Path-B native-sandbox suite. **Desktop product admission for Cursor is
Path-B always-enabled** (contained `--sandbox` argv on `runCursorProvider`);
the current transport also registers TaskWraith's governed tool broker. The
live suite is containment evidence, not a fail-closed desktop kill switch.
The active required *release* fingerprint tuple may still be Kimi-weighted while
the exact Kimi reviewed roster remains empty — desktop Kimi admission is
always-enabled (structural checks; unreviewed runs are labelled
`unattested-development`), but signed `v*` publication jobs that require a
successful protected provider release attestation stay red until a reviewed
Kimi tuple is commissioned. Probe-
only inventory may still invoke `--version` and `--help` in an unauthenticated
root. Prefer project workspaces outside `$HOME` for untrusted Cursor work; the
sandbox is an honest partial backstop (see TW-SEC-2026-003). The workflow is
explicitly credentialed and protected, not a pull-request or scheduled cloud
lane. See
[Provider permission conformance](PROVIDER_PERMISSION_CONFORMANCE.md). Coverage
artifacts are written under `artifacts/coverage/` for inspection only.

The release path is designed to run dependency checks, typecheck, tests, native
bridge tests on macOS, packaged-app smoke tests, update-feed validation, secret
bundle guards, signing, notarization, stapling, and SBOM generation where the
required credentials are available.

For downloaded macOS artifacts, compare against the published SHA-256 checksum source
when provided (release notes or a checksums file), or otherwise verify local hashes
against the published release metadata.

```sh
shasum -a 256 TaskWraith-<version>-universal-mac.dmg
```

After installation, macOS users can verify the app locally:

```sh
codesign --verify --deep --strict --verbose=2 /Applications/TaskWraith.app
spctl --assess --type execute --verbose=4 /Applications/TaskWraith.app
xcrun stapler validate /Applications/TaskWraith.app
```

Windows and Linux artifacts should be treated according to the release notes.
When an artifact is labelled unsigned, do not infer platform signing guarantees
from the source repository alone.

## Known Limits

- TaskWraith is not a security boundary around all provider-native behavior.
- Approval prompts reduce accidental or model-driven misuse, but they do not make
  arbitrary third-party CLIs safe.
- Provider-authored transcript prose, provider-native session history, and
  explicitly enabled debug capture can retain content omitted from
  TaskWraith's redacted approval, Canvas-audit, and compatibility/tool-event
  projections.
- Display redaction is best effort. Raw transcripts, run events, provider output,
  diagnostics, media, and exported files can still be sensitive.
- Broad grants such as full-workspace, yolo, unattended workflows, or remote
  allowlists are intentionally powerful. Use them only after a low-risk trial.
- Public adoption is still small, so cautious users should rely on source review,
  verification steps, and no-risk trials before trusting important workspaces.
