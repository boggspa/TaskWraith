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
2. Run in read-only or planning mode first.
3. Review the activity log, approval ledger, and generated diffs.
4. Move to meaningful workspaces only after several low-risk sessions behave as
   expected.

## Trust Model

TaskWraith's authority is centered on the Mac app:

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

## Safe First Run

Use this path when evaluating TaskWraith for the first time:

1. Create or clone a disposable repository.
2. Open that repository as the selected workspace.
3. Use a provider you already trust and understand.
4. Pick a read-only or planning posture. Avoid full-workspace, yolo, auto-edit,
   or broad session grants.
5. Ask for a non-mutating task, such as "summarize the project layout" or "find
   likely test entry points."
6. Inspect the Activity view and Raw Events. Confirm the provider only read what
   you expected.
7. Ask for a small edit in a throwaway file. Review the Diff Studio result before
   committing anything.
8. Open Settings and inspect the Approval Ledger after the run.
9. Only then try a real project, still avoiding broad grants until the workflow
   has earned your trust.

Leave these disabled during first-run testing:

- iOS or remote-device pairing.
- Human collaboration / shared-chat invites.
- Screen Watch and attached-window capture.
- Canvas/browser automation.
- Creative-app AppleScript automation.
- External message-channel bridges.
- Full-workspace or unattended workflow grants.

When you are ready to enable optional surfaces, see
[ADVANCED_OPTIONAL_SETUP.md](ADVANCED_OPTIONAL_SETUP.md) for the external steps
around Ollama models, API keys, iOS/Tailscale pairing, Screen Watch, message
bridges, creative apps, and custom MCP servers.

## Capability Matrix

| Surface | Default posture | What it can access | What may leave your Mac | Approval and audit |
| --- | --- | --- | --- | --- |
| Provider runs | User starts a run in a selected chat/workspace. | Prompt text, selected workspace context, and provider-visible tool results. | Anything sent to the chosen provider CLI/API according to that provider's behavior. | Provider/tool approval cards and run events are stored locally. |
| Workspace reads/search | Scoped to the selected workspace where the adapter can enforce it. | File names and file contents in the selected workspace. | File snippets may be sent to the active provider as context. | Activity rows and raw provider events are retained. |
| File edits and Diff Studio | Mutating edits require an edit-capable mode or explicit approval. | Files in the selected workspace, plus user-approved external paths where supported. | Diffs/content may be visible to the active provider. | Diffs are reviewable before commit; approvals are ledgered. |
| Shell and git | Approval-gated unless the selected provider mode grants more authority. | Commands run in the workspace context; git status/diff/commit surfaces. | Command output can be sent to the provider and stored in local history. | Command approvals, auto-denies, and run events are auditable. |
| Local Ollama tools | Tiered from read-only to provider parity. | Depends on the selected local-model tool tier. | Local model prompts stay local unless you use Ollama-hosted/cloud models or other network tools. | Tool tier and mutating operations are policy-gated. |
| Ensembles, sub-threads, audits | User-created or explicitly delegated. | The transcript and workspace context available to each participant/provider. | Each cloud participant may receive transcript/context needed for its turn. | Participant runs, audit findings, and delegation events are recorded locally. |
| Workflows and scheduled runs | User-defined. Unattended elevation requires explicit acknowledgement. | The workspace and tools allowed by the workflow template. | Same provider exposure as a normal run, repeated by schedule. | Workflow history, approvals, and run state are persisted. |
| iOS remote bridge | Disabled until paired. | Read-only projections by default; selected actions only through Mac policy. | Relay/APNs should see routing metadata, not plaintext prompts, commands, diffs, or model output. | Pairing, allowlists, approvals, expiry, and replay checks are enforced on the Mac. |
| Human collaborators | Host-created invite per shared chat. | Least-privilege projection of one shared chat; collaborator comments when allowed. | Projection/comment frames travel over the collaboration transport, encrypted end to end. | Host remains authority for transcript writes; comments are external/untrusted rows. |
| Screen Watch / attached windows | Off until the user attaches a window. | Frames from the chosen window, one frame at a time. | Captured frames may be sent to the active provider as visual context. | Attachment and downstream tool actions are surfaced in the run. |
| Canvas/browser-like tools | Optional advanced surface. | The page or preview surface you expose to the agent. | URLs, page content, screenshots, and actions may reach the provider depending on the tool. | High-risk actions are policy-gated and should be treated as code/data execution. |
| Creative-app automation | Off unless configured and approved. | Supported app state and AppleScript automation targets such as Final Cut Pro or Logic Pro. | App snapshots or command results may be sent to the provider. | AppleScript dispatch is approval-gated and logged. |
| Discord context | Off unless a bot token/server is configured. | Recent messages from configured Discord channels the bot can read. | Channel context is attached to provider prompts as untrusted context. | Read-only; TaskWraith does not post back to Discord through this feature. |
| Message-channel bridges | Off unless configured. | Local message-channel metadata and messages within configured routes. | Routed message content may become untrusted context or audit records. | Channel bindings, cursors, and audit entries are stored locally. |
| Media and image tools | User/provider initiated. | Transcript media, generated images, selected audio/video files, and decoded frames. | Media-derived context may be sent to providers or external generation APIs you configure. | Media refs use trusted channels; generated artifacts remain reviewable locally. |
| Usage and diagnostics | Local collection. | Provider usage summaries, app status, crashes, and diagnostics exports. | Diagnostics leave the machine only if you export/share them. | Stored under local app data; exports should be treated as sensitive. |

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
- `bridge/` pairing records, remote workspace allowlists, and APNs routing token
  records.
- `human-collaboration.json` and the local collaboration identity record when
  collaborator features are used.
- `channels/` message-channel bindings, cursors, and audit logs when configured.
- Transcript media assets, media staging, Canvas state, and generated artifacts.

TaskWraith does not store provider account passwords in the repository. Provider
CLIs and SDKs keep their own credentials wherever those tools normally store
them. Remote bridge identity material is protected with Electron `safeStorage`
where available.

To reset TaskWraith's local state, quit the app and move or delete the
`userData` directory above. To keep a backup, move it aside rather than deleting
it. Provider CLI credentials may remain in the provider's own config locations.

## What Can Leave the Machine

Local-first does not mean air-gapped. Data can leave your Mac when you choose a
feature that necessarily talks to another system:

- Cloud provider runs send prompts, selected context, tool outputs, and sometimes
  files or diffs to that provider.
- Provider CLIs may maintain their own logs, caches, telemetry, or remote
  sessions outside TaskWraith.
- Web search/fetch, browser, Canvas, image-generation, and media-analysis tools
  can contact external services depending on configuration.
- Discord context reads from Discord through your configured bot token.
- iOS bridge and collaborator transports use relay/routing infrastructure, but
  are designed so relay/APNs payloads do not carry plaintext prompts, commands,
  diffs, or model output.
- Diagnostics exports are local files until you share them.

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

The release path is designed to run dependency checks, typecheck, tests, native
bridge tests on macOS, packaged-app smoke tests, update-feed validation, secret
bundle guards, signing, notarization, stapling, and SBOM generation where the
required credentials are available.

For downloaded macOS artifacts, compare the GitHub release checksum with:

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
- Display redaction is best effort. Raw transcripts, run events, provider output,
  diagnostics, media, and exported files can still be sensitive.
- Broad grants such as full-workspace, yolo, unattended workflows, or remote
  allowlists are intentionally powerful. Use them only after a low-risk trial.
- Public adoption is still small, so cautious users should rely on source review,
  verification steps, and no-risk trials before trusting important workspaces.
