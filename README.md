# TaskWraith

TaskWraith is a local-first desktop workbench for running and reviewing AI coding
agents against developer workspaces. It provides a macOS-focused Electron UI for
provider CLIs and SDK-backed workflows while keeping execution, history, and
workspace state on the user's machine.

> **iOS companion status:** TaskWraith for iPhone/iPad is pending
> TestFlight/App Store review. Until then, the iOS companion is provisionally
> available from this repository for testers who can sign and provision the app
> with their own Apple Developer team.

<table>
  <tr>
    <td align="center" valign="top" width="33%">
      <img width="100%" alt="Welcome and provider setup" src="https://github.com/user-attachments/assets/9a3036ec-3761-4a64-98d9-bec13d44c996" /><br />
      <sub><b>Welcome &amp; provider setup</b></sub>
    </td>
    <td align="center" valign="top" width="33%">
      <img width="100%" alt="Ensemble Mode" src="https://github.com/user-attachments/assets/1523ff12-b8c2-41e8-a966-d735ee545e38" /><br />
      <sub><b>Ensemble Mode</b></sub>
    </td>
    <td align="center" valign="top" width="33%">
      <img width="100%" alt="A live ensemble run" src="https://github.com/user-attachments/assets/95eb5142-7c41-4f2e-82e5-14e22e4ab911" /><br />
      <sub><b>A live Ensemble run</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center" valign="top" width="33%">
      <img width="100%" alt="Git-aware composer" src="https://github.com/user-attachments/assets/e50e5f5d-eb7b-4a34-9fe1-50eb8d54a5d1" /><br />
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
- **Provider Runs**: Integrated run surfaces for Codex, Claude, Gemini, Kimi,
  Grok, Cursor, and **local Ollama** (curated Qwen, Gemma, and GPT-OSS presets).
  Provider names describe compatible integrations only — CLIs and accounts stay
  user-installed.
- **Thread Goals**: Set a persistent objective with `/goal <objective>` or the
  composer goal control. Codex uses native goal state when the installed runtime
  exposes it; every provider gets a TaskWraith-managed fallback with explicit
  complete/blocked lifecycle tools.
- **Ensemble Mode**: Multi-provider single-thread chats with up to six named
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
- **Release Tooling**: Security, dependency, packaging, and signing hooks for
  reproducible local release work.

Current release: **v1.5.3** — see [CHANGELOG.md](CHANGELOG.md) for release notes.

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
through the agents and are reviewed and merged by a human. Commits carry
`Co-Authored-By` trailers for the agents that contributed.

## Development Setup

1. Install Node.js 20 or newer.
2. Install any provider CLI you intend to use separately.
3. Run `npm ci`.
4. Run `npm run dev`.

Use `npm ci` for clean installs so npm follows the committed lockfile exactly.
Run `npm run security:deps` before release work or after dependency changes.

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

See `CHANGELOG.md` for release history, and `ARCHITECTURE.md`, `SAFETY.md`,
`SECURITY.md`, and `TERMS_NOTES.md` for more detail.
