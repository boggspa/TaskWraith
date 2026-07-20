# Trust and Safety

<p align="center">
  <img src="design-assets/ghost/ghost-guy-mark-monoline.svg" alt="TaskWraith monoline mark" width="72" />
</p>

TaskWraith is a local-first agent workbench, but it is still software that can
coordinate powerful tools against a developer machine. Treat it like a shell,
editor, git client, browser automation surface, and remote-control bridge in one
app: start with low-risk work, inspect what it asks for, and only widen trust
after the behavior is boring and understandable.

This page is written for cautious users deciding whether to try the app on a real
workspace. Engineering guardrails are also documented in [SAFETY.md](SAFETY.md)
and [SECURITY.md](SECURITY.md).

## Current Maturity

TaskWraith is a young public project with a small adoption footprint. The source
is public and the release pipeline has security checks, but there has not yet
been enough independent usage, third-party review, or enterprise deployment to
make "many people use it" a substitute for your own evaluation.

Recommended posture:

1. Try a scratch repository first.
2. Run in Read-only/Recon or Plan workflow first.
3. Review the activity log, approval ledger, and generated diffs.
4. Move to meaningful workspaces only after several low-risk sessions behave as
   expected.

Plan workflow is distinct from Read-only/Recon. It still uses a read-only
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
  pairing, allowlists, end-to-end encryption, and host-side authority. They still
  expand the attack surface and should be enabled deliberately.

The tagged v1.8.4 release is the current public baseline. This repository can
also contain source-ahead hardening that is not a released guarantee until it is
named in later release notes. In particular, main-authoritative Ensemble direct
routing, managed Cursor Path-B re-entry (contained sandbox argv), and
content-minimised `canvas_eval` approval receipts described below are
source-ahead changes.

## Safe First Run

Use this path when evaluating TaskWraith for the first time:

1. Create or clone a disposable repository.
2. Open that repository as the selected workspace.
3. Use a provider you already trust and understand.
4. Pick Read-only/Recon or Plan workflow. Avoid full-workspace, yolo,
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
- Human collaboration / shared-chat invites.
- Screen Watch and attached-window capture.
- Canvas/browser automation.
- Creative-app AppleScript automation.
- Full-workspace or unattended workflow grants.

When you are ready to enable optional surfaces, see
[ADVANCED_OPTIONAL_SETUP.md](ADVANCED_OPTIONAL_SETUP.md) for the external steps
around Ollama models, API keys, iOS/Tailscale pairing, Screen Watch, creative
apps, and custom MCP servers.

Managed Cursor is live again under **Path-B**: TaskWraith always-enables a
contained `cursor-agent` with hard-pinned `--sandbox enabled` and seat-routed
read-only vs write argv. Path B accepts own-account trust (real `~/.cursor`
login; account skills/plugins/MCP may load but are sandbox-bounded). TaskWraith
does not inject host MCP tools or mediate Cursor per-tool approvals. Treat the
sandbox as an honest partial backstop — not a full egress or
workspace-under-`$HOME` seal. See `SECURITY_ENGINEERING_LEDGER.md`
(TW-SEC-2026-003) and `CHANGELOG.md`.

## Capability Matrix

| Surface                            | Default posture                                                                                   | What it can access                                                                                                                                                                                                                                                | What may leave your computer                                                                                                                                                                     | Approval and audit                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider runs                      | User starts a run in a selected chat/workspace.                                                   | Prompt text and any provider-visible transcript/tool context. Qualified workspace-aware seats may access selected-workspace context. Path-B Cursor uses native tools under the OS sandbox rather than TaskWraith-injected host tools.                              | Anything sent to the chosen provider CLI/API according to that provider's behavior.                                                                                                              | Provider/tool approval cards and run events are stored locally where the seat uses TaskWraith mediation; Path-B Cursor relies on sandbox argv containment instead of per-tool cards.                                                                                                                                                                                       |
| Workspace reads/search             | Scoped to the selected workspace where the adapter can enforce it.                                | File names and file contents in the selected workspace for qualified tool-capable seats.                                                                                                                                                                          | File snippets may be sent to the active provider as context.                                                                                                                                     | Activity rows and raw provider events are retained.                                                                                                                                                                                                                                                                                                                       |
| Plan workflow                      | User-selected Plan preset.                                                                        | Workspace context needed to draft a plan, plus a validated markdown plan artifact path when the proposed-plan flow saves one.                                                                                                                                     | Plan content may be sent to the active provider and stored locally as the plan artifact.                                                                                                         | The markdown-plan write is product-managed; other mutating tools remain blocked until approval or a higher permission posture.                                                                                                                                                                                                                                            |
| File edits and Diff Studio         | Mutating edits require an edit-capable mode or explicit approval.                                 | Files in the selected workspace, plus user-approved external paths where supported.                                                                                                                                                                               | Diffs/content may be visible to the active provider.                                                                                                                                             | Diffs are reviewable before commit; approvals are ledgered.                                                                                                                                                                                                                                                                                                               |
| Shell and git                      | Approval-gated unless the selected provider mode grants more authority.                           | Commands run in the workspace context; git status/diff/commit surfaces.                                                                                                                                                                                           | Command output can be sent to the provider and stored in local history.                                                                                                                          | Command approvals, auto-denies, and run events are auditable.                                                                                                                                                                                                                                                                                                             |
| Local Ollama tools                 | Same permission presets as other providers; run profiles tune local prompting/runtime behavior.   | The TaskWraith tool surface where local capability exists, limited by permission posture and network policy.                                                                                                                                                      | Local model prompts stay local unless you use Ollama-hosted/cloud models or other network tools.                                                                                                 | Standard run permission posture and approvals apply; there is no separate safety-tier ladder.                                                                                                                                                                                                                                                                             |
| Ensembles, sub-threads, audits     | User-created or explicitly delegated.                                                             | The transcript and provider-qualified context available to each runnable participant. Path-B Cursor can be a solo seat, ensemble participant, or delegated child; it is not a TaskWraith MCP parent seat. In source-ahead builds, main validates exact picker identity and rejects ambiguous plain direct mentions. | Each cloud participant may receive transcript/context needed for its turn.                                                                                                                       | Participant runs, audit findings, and delegation events are recorded locally.                                                                                                                                                                                                                                                                                             |
| Workflows and scheduled runs       | User-defined. Unattended elevation requires explicit acknowledgement.                             | The workspace and tools allowed by the workflow template.                                                                                                                                                                                                         | Same provider exposure as a normal run, repeated by schedule.                                                                                                                                    | Workflow history, approvals, and run state are persisted.                                                                                                                                                                                                                                                                                                                 |
| Transcript sky and weather visuals | Network lookup runs only while sky visual FX are enabled; disabling the FX stops weather polling. | The host's public-IP-derived approximate location and current weather conditions. No task, transcript, or workspace content is used.                                                                                                                              | The public IP is visible to `ipapi.co`, with `ipwho.is` as fallback. Open-Meteo receives the rounded coordinates (0.1°, about 11 km) and, like any direct web service, the request's source IP.  | The last coarse location and weather snapshot are cached locally in `host-weather-cache.json`; this automatic visual lookup does not use the agent approval flow.                                                                                                                                                                                                         |
| iOS remote bridge                  | Disabled until paired.                                                                            | Read-only projections by default; selected actions only through Mac policy.                                                                                                                                                                                       | Relay/APNs should see routing/status metadata, which may include aggregate added/deleted line counts, but not plaintext prompts, commands, diff contents or hunks, or model output.              | Pairing, allowlists, approvals, expiry, and replay checks are enforced on the Mac.                                                                                                                                                                                                                                                                                        |
| Human collaborators                | Host-created invite per shared chat.                                                              | Least-privilege projection of one shared chat; collaborator comments when allowed.                                                                                                                                                                                | Projection/comment frames travel over the collaboration transport, encrypted end to end.                                                                                                         | Host remains authority for transcript writes; comments are external/untrusted rows.                                                                                                                                                                                                                                                                                       |
| Screen Watch / attached windows    | Off until the user attaches a window.                                                             | Frames from the chosen window, one frame at a time.                                                                                                                                                                                                               | Captured frames may be sent to the active provider as visual context.                                                                                                                            | Attachment and downstream tool actions are surfaced in the run.                                                                                                                                                                                                                                                                                                           |
| Canvas/browser-like tools          | Optional advanced surface.                                                                        | The page or preview surface you expose to the agent.                                                                                                                                                                                                              | URLs, page content, screenshots, actions, and direct tool results may reach the provider depending on the tool. Provider assistant prose may echo scripts/results into the persisted transcript. | High-risk actions are policy-gated. Source-ahead `canvas_eval` shows the exact script only in the transient desktop approval. Human-approved execution and Canvas-audit receipts retain approval id, unkeyed SHA-256, lengths, and outcome rather than script/result; auto-denial and compatibility/tool rows are content-redacted but may omit that full receipt. The digest is correlation/integrity metadata, not encryption. |
| Creative-app automation            | Off unless configured and approved.                                                               | Supported app state and AppleScript automation targets such as Final Cut Pro or Logic Pro.                                                                                                                                                                        | App snapshots or command results may be sent to the provider.                                                                                                                                    | AppleScript dispatch is approval-gated and logged.                                                                                                                                                                                                                                                                                                                        |
| Discord context                    | Off unless a bot token/server is configured.                                                      | Recent messages from configured Discord channels the bot can read.                                                                                                                                                                                                | Channel context is attached to provider prompts as untrusted context.                                                                                                                            | Read-only; TaskWraith does not post back to Discord through this feature.                                                                                                                                                                                                                                                                                                 |
| Media and image tools              | User/provider initiated.                                                                          | Transcript media, generated images, selected audio/video files, and decoded frames.                                                                                                                                                                               | Media-derived context may be sent to providers or external generation APIs you configure.                                                                                                        | Media refs use trusted channels; generated artifacts remain reviewable locally.                                                                                                                                                                                                                                                                                           |
| Usage and diagnostics              | Local collection.                                                                                 | Provider usage summaries, app status, crashes, and diagnostics exports.                                                                                                                                                                                           | Diagnostics leave the machine only if you export/share them.                                                                                                                                     | Stored under local app data; exports should be treated as sensitive.                                                                                                                                                                                                                                                                                                      |

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

Local-first does not mean air-gapped. Data can leave your computer when you choose a
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
- iOS bridge and collaborator transports use relay/routing infrastructure, but
  are designed so relay/APNs payloads do not carry plaintext prompts, commands,
  diffs, or model output.
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
npm run verify:provider-permissions:release
npm run test:coverage:baseline
```

The reviewed live-test allowlist includes Kimi's ACP containment suite and
Cursor's Path-B native-sandbox suite. **Desktop product admission for Cursor is
Path-B always-enabled** (contained `--sandbox` argv on `runCursorProvider`);
the live suite is containment evidence, not a fail-closed desktop kill switch.
The active required *release* fingerprint tuple may still be Kimi-weighted while
the exact Kimi packaged roster remains empty — strict packaged Kimi admission
and signed `v*` publication jobs that require a successful protected provider
release attestation stay red until a reviewed Kimi tuple is commissioned. Probe-
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
