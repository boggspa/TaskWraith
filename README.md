# TaskWraith

<p align="center">
  <img src="design-assets/ghost/ghost-guy-mark-monoline.svg" alt="TaskWraith monoline mark" width="72" />
</p>

[![CI](https://github.com/boggspa/TaskWraith/actions/workflows/ci.yml/badge.svg)](https://github.com/boggspa/TaskWraith/actions/workflows/ci.yml)
![Latest GitHub release](https://img.shields.io/github/v/release/boggspa/TaskWraith)
![License](https://img.shields.io/github/license/boggspa/TaskWraith)

TaskWraith is a local-first desktop workbench for running and reviewing AI coding
agents against developer workspaces. It provides a macOS-focused Electron UI for
provider CLIs and SDK-backed workflows while keeping execution, history, and
workspace state on the user's machine.

> **iOS companion status:** TaskWraith for iPhone/iPad is in **TestFlight beta**.
> It is a **Mac companion** — it pairs with TaskWraith on macOS over an
> end-to-end-encrypted connection to monitor runs, approve actions, and reply
> from the phone; it is not a standalone AI app. Remote actions are governed by
> the Mac's workspace allowlists and approval policy. Relay/APNs infrastructure
> may see routing metadata, not plaintext prompts, commands, diffs, or model
> output. Testers can also build it from this repository with their own Apple
> Developer team. Push notifications are opt-in after pairing and require APNs
> credentials on the Mac (see
> `ios/TaskWraithApp/README.md`).

## Trust, Safety, and First Runs

<table>
  <tr>
    <td width="76" align="center" valign="middle">
      <img src="design-assets/ghost/ghost-guy-mark-monoline.svg" alt="" width="48" />
    </td>
    <td valign="middle">
      <strong>Start with low-risk work.</strong><br />
      TaskWraith is designed to keep permissions visible and auditable, but it
      still coordinates powerful local tools. Use a scratch repo and read-only
      posture first, then widen trust only after the behavior is familiar.
    </td>
  </tr>
</table>

TaskWraith has a broad optional permissions surface: provider CLIs, local models,
workspace file tools, shell/git actions, iOS remote control, collaborator
sharing, Screen Watch, Canvas/browser-like tools, media tools, and creative-app
automation. The default expectation is explicit user control: select a workspace,
choose a run posture, review approvals, inspect activity, and check diffs before
committing generated work.

New users should start with a scratch repository in read-only or planning mode.
Do not enable remote pairing, Screen Watch, Canvas/browser automation, creative
app bridges, unattended workflow grants, or full-workspace/yolo permissions until
the app has earned trust through several low-risk sessions.

Read [TRUST_AND_SAFETY.md](TRUST_AND_SAFETY.md) for the safe-first-run guide,
capability matrix, storage locations, provider data boundaries, release
verification steps, and known limits. Optional features that require outside
accounts, local services, or macOS permissions are covered in
[ADVANCED_OPTIONAL_SETUP.md](ADVANCED_OPTIONAL_SETUP.md). [SAFETY.md](SAFETY.md)
and [SECURITY.md](SECURITY.md) contain the engineering guardrails and release
baseline.

<table>
  <tr>
    <td align="center" valign="top" width="33%">
      <img width="100%" alt="Welcome and provider setup" src="design-assets/readme-screenshots/welcome-provider-setup.png" /><br />
      <sub><b>Welcome &amp; provider setup</b></sub>
    </td>
    <td align="center" valign="top" width="33%">
      <img width="100%" alt="General App Layout" src="design-assets/readme-screenshots/general-app-layout.png" /><br />
      <sub><b>General App Layout</b></sub>
    </td>
    <td align="center" valign="top" width="33%">
      <img width="100%" alt="A live Ensemble run" src="design-assets/readme-screenshots/live-ensemble-run.png" /><br />
      <sub><b>A live Ensemble run</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center" valign="top" width="33%">
      <img width="100%" alt="Pop-Out Chat Windows" src="https://github.com/user-attachments/assets/e50e5f5d-eb7b-4a34-9fe1-50eb8d54a5d1" /><br />
      <sub><b>Pop-Out Chat Windows</b></sub>
    </td>
    <td align="center" valign="top" width="33%">
      <img width="100%" alt="Diff Studio" src="https://github.com/user-attachments/assets/b671a8a0-a81a-44b9-8383-37a8d47da478" /><br />
      <sub><b>Diff Studio</b></sub>
    </td>
    <td align="center" valign="top" width="33%">
      <img width="100%" alt="File Editor" src="https://github.com/user-attachments/assets/fcb6cfce-e65d-41d5-a466-95ccf7b9cfb8" /><br />
      <sub><b>File Editor</b></sub>
    </td>
  </tr>
</table>



## Features

- **Workspace Safety**: Workspace selection, trust-state visibility, approval
  modes, and run-scoped safety state before agents operate on local files.
- **Provider Runs**: Integrated run surfaces for Codex, Claude, Kimi, Grok,
  Cursor, and **local Ollama** (curated Qwen, Gemma, and GPT-OSS presets).
  Historical Gemini chats remain readable, but Gemini is retired for new runs.
  Provider names describe compatible integrations only — CLIs and accounts stay
  user-installed.
- **Multiview and Workflows**: Split the workbench into live panes, and run
  Workflows as first-class chat/run objects with scheduled recovery, dedicated
  sidebar space, and optional ensemble execution where enabled.
- **Thread Goals**: Set a persistent objective with `/goal <objective>` or the
  composer goal control. Codex uses native goal state when the installed runtime
  exposes it; every provider gets a TaskWraith-managed fallback with explicit
  complete/blocked lifecycle tools.
- **Composer Shells**: Provider-aware and task-oriented composer variants give
  each working mode its own affordances without changing the safety model. See
  [COMPOSER_VARIANTS.md](COMPOSER_VARIANTS.md) for the Electron shell gallery.
- **Ensemble Mode**: Multi-provider single-thread chats with up to twelve named
  participants, turn-bound or continuous orchestration, optional parallel fan-out,
  and TaskWraith MCP tools shared across providers.
- **Audit Runs**: `/audit` can coordinate provider-backed review passes with
  live progress, structured findings, verdicts, and dismissible run banners.
- **Local Ollama**: Tiered workspace tools (read-only through provider parity),
  optional live web search/fetch, per-model context engineering, and session memory
  across runs — all policy-gated like cloud providers.
- **Activity Review**: Live activity viewport for in-flight tools and thinking,
  compact timelines, durations, and raw event inspection.
- **Diff Studio**: File-list and diff-detail review for run-scoped changes and
  current workspace changes, including previews for newly created text files.
- **Local History and Usage**: Local-only chat, run, usage, approval-ledger, and
  audit state for repeat work without a hosted backend.
- **iOS Companion**: TestFlight companion surfaces Demo Mode, Workflows,
  first-launch/provider readiness, usage snapshots, approvals, questions,
  transcript streaming, inline images, and remote file/diff inspection.
- **Release Tooling**: Security, dependency, packaging, and signing hooks for
  reproducible local release work.

Current development version: **v1.6.3**. Latest public release:
**v1.6.3** — see [CHANGELOG.md](CHANGELOG.md) for release notes.
If the GitHub Releases page shows an older version, treat newer source changes as
unreleased development work until a matching tag and release artifacts are
published.

## Public Source Boundary

TaskWraith source code is licensed under Apache-2.0. Provider product names are
used nominatively to describe interoperability with user-installed tools and
accounts. The repository does not intentionally bundle provider logos,
trademarks, API credentials, signing material, or proprietary provider fonts.

Users are responsible for installing and authenticating the provider CLIs, SDKs,
or accounts they choose to use. TaskWraith does not bypass provider authentication,
quotas, rate limits, approval flows, or terms of service.

## Built with AI Agents

TaskWraith is developed the way it is meant to be used — with AI coding agents in
the loop. Day-to-day work pairs **OpenAI Codex** and **Anthropic Claude**:
planning, implementation, multi-agent review passes, and large refactors run
through the agents. Agent output is reviewed by a human before merge, and release
work is gated by dependency checks, typecheck, tests, native bridge tests on
macOS, packaged-app smoke tests, signing/notarization validation where
credentials are available, and secret-bundle guards. Commits carry
`Co-Authored-By` trailers for the agents that contributed.

## Development Setup

1. Install Node.js 20 or newer.
2. Install any provider CLI you intend to use separately.
3. Run `npm ci`.
4. Run `npm run dev`.

Use `npm ci` for clean installs so npm follows the committed lockfile exactly.
Run `npm run security:deps` before release work or after dependency changes.

## Discord Context

Discord Context is optional and read-only: it attaches recent messages from
bot-accessible channels as untrusted context and does not post back to Discord.
Setup requires a Discord bot token, at least one guild/server ID, and channel
read permissions; see
[Advanced Optional Setup - Discord Context](ADVANCED_OPTIONAL_SETUP.md#discord-context)
for the environment variables and packaged-app config path.

## Useful Commands

```sh
npm run security:deps
npm run typecheck
npm run test
npm run test:swift:bridge   # macOS only — see note below
npm run build
```

`npm run test:swift:bridge` runs the native macOS bridge daemon's Swift test
suite in `swift/TaskWraithBridge`. The bridge gates native macOS actions
(Screen Watch, creative-app, and editor helpers), so its tests run
automatically in two places: the macOS legs of CI, and the `build:mac` /
`build:mac:notarized` release recipes (as a pre-flight gate, so a release
build fails fast on a bridge regression). It requires macOS with the Xcode
Swift toolchain and is not part of the cross-platform `npm run ci`.

## Project Layout

- `src/main`: Electron main process, provider orchestration, persistence, and
  workspace safety services.
- `src/preload`: Narrow IPC bridge exposed to the renderer.
- `src/renderer`: React UI, provider review surfaces, settings, and visual
  system.
- `swift`: macOS bridge daemon sources used by local release builds.
- `scripts`: Build, security, validation, signing, and packaging utilities.

See `CHANGELOG.md` for release history, and `TRUST_AND_SAFETY.md`,
`ADVANCED_OPTIONAL_SETUP.md`, `COMPOSER_VARIANTS.md`, `ARCHITECTURE.md`,
`SAFETY.md`, `SECURITY.md`, and `TERMS_NOTES.md` for more detail.
