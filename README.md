<p align="center">
  <img src="design-assets/ghost/ghost-guy-mark-monoline.svg" alt="TaskWraith monoline ghost mark" width="88" />
</p>

<h1 align="center">TaskWraith</h1>

<p align="center">
  <strong>Orchestrate. Collaborate. Deliver.</strong>
</p>

<p align="center">
  A local-first desktop workbench for running and reviewing AI coding agents<br />
  against your own repositories.
</p>

<p align="center">
  <a href="https://github.com/boggspa/TaskWraith/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/boggspa/TaskWraith/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/boggspa/TaskWraith/releases/latest"><img alt="Latest GitHub release" src="https://img.shields.io/github/v/release/boggspa/TaskWraith" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/boggspa/TaskWraith" /></a>
</p>

<p align="center">
  <strong><a href="https://github.com/boggspa/TaskWraith/releases/latest">Download</a></strong>
  ·
  <a href="https://github.com/boggspa/TaskWraith">Source</a>
  ·
  <a href="docs/TRUST_AND_SAFETY.md">Trust &amp; Safety</a>
</p>

<p align="center">
  <sub>Free and open source. macOS, Windows and Linux.</sub>
</p>

<p align="center">
  <img src="design-assets/readme-screenshots/live-ensemble-run.png" alt="Multiple AI agents collaborating in a TaskWraith Ensemble" width="960" />
</p>

## Many agents, one checkout

TaskWraith coordinates coding agents from multiple providers in one desktop app.
Stay focused with one agent, isolate parallel work in sub-threads, or invite a
small Ensemble to deliberate and review in a shared transcript.

- **Every model, one thread.** Bring compatible provider seats together without
  losing the conversation, workspace timeline, or review trail.
- **Nothing lands without you.** Give every seat explicit authority, then review
  TaskWraith-brokered approvals, activity, and diffs in one place.
- **Your bench, your look.** Shape the palette, density, layout, and Multiview
  workspace around the way you work.
- **Spend with no surprises.** Keep provider usage signals and run activity
  visible while each account and quota stays under its provider's control.
- **Powerful on day one.** Welcome, Goals, Diff Studio, Canvas, terminal, and
  familiar chat workflows are ready when you need them.

<table>
  <tr>
    <td align="center" valign="top" width="33%">
      <img width="100%" alt="TaskWraith welcome and provider setup" src="design-assets/readme-screenshots/welcome-provider-setup.png" /><br />
      <sub><b>Set up your bench</b></sub>
    </td>
    <td align="center" valign="top" width="33%">
      <img width="100%" alt="TaskWraith desktop layout" src="design-assets/readme-screenshots/general-app-layout.png" /><br />
      <sub><b>Keep the work in view</b></sub>
    </td>
    <td align="center" valign="top" width="33%">
      <img width="100%" alt="TaskWraith Diff Studio" src="design-assets/readme-screenshots/diff-studio.png" /><br />
      <sub><b>Review before you land</b></sub>
    </td>
  </tr>
</table>

## Start in three steps

1. **Download TaskWraith** from the
   [latest GitHub release](https://github.com/boggspa/TaskWraith/releases/latest).
   Choose the checksum-listed installer for macOS, Windows, or Linux and verify
   it against the release's `SHA256SUMS-<version>.txt`.
2. **Bring a provider.** Install and sign in to the provider CLI or account you
   want to use; TaskWraith does not bundle those credentials or bypass provider
   authentication. Local Ollama models are supported too.
3. **Begin somewhere safe.** Add a scratch repository, start with Ask or a
   read-only posture, and widen access only after you are comfortable reviewing
   approvals, activity, and diffs.

The optional [iPhone and iPad companion](ios/TaskWraithApp/README.md) is in
TestFlight beta and pairs with TaskWraith on macOS; it is not a standalone AI
app.

### Build from source

For contributors, install Node.js 20 or newer and any provider CLI you plan to
use, then run:

```sh
npm ci
npm run dev
```

> **Source-ahead note:** this checkout may contain work newer than the latest
> public tag. The top `CHANGELOG.md` entry describes source-ahead changes; they
> are not shipped until a new tag and matching artifacts are published.

## Find your way

| Explore                                           | What you will find                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Positioning](docs/POSITIONING.md)                | The product promise, claim boundaries, and a guide to solo chats, sub-threads, and Ensembles    |
| [Trust & Safety](docs/TRUST_AND_SAFETY.md)        | Safe first runs, permissions, storage, provider boundaries, and release verification            |
| [Privacy](docs/PRIVACY.md)                        | What stays local, what providers receive, optional observation, and remote companion boundaries |
| [Security](SECURITY.md)                           | Supported versions, reporting, disclosure, and release security                                 |
| [Safety](docs/SAFETY.md)                          | Engineering guardrails, implemented protections, and known limits                               |
| [Model Catalogue](docs/MODEL_CATALOGUE.md)        | Current provider and model rows, reasoning controls, and route-specific limits                  |
| [Changelog](CHANGELOG.md)                         | Shipped releases and the clearly labelled source-ahead section                                  |
| [Advanced setup](docs/ADVANCED_OPTIONAL_SETUP.md) | Optional accounts, services, remote features, and platform permissions                          |
| [Architecture](docs/ARCHITECTURE.md)              | The desktop, runtime, orchestration, and persistence map                                        |

TaskWraith keeps your workspace, local history, and approvals on your machine.
Prompts and run context go to whichever provider you select. Provider tools and
native boundaries vary, so use the catalogue and trust guide for the current
details.

TaskWraith is [Apache-2.0 licensed](LICENSE). Provider product names identify
compatible integrations and do not imply endorsement; provenance and
source-specific rights notes live with the relevant
[design assets](design-assets/provider-logos/) and in
[Terms Notes](docs/TERMS_NOTES.md).
