# Advanced Optional Setup

<p align="center">
  <img src="design-assets/ghost/ghost-guy-mark-monoline.svg" alt="TaskWraith monoline mark" width="72" />
</p>

TaskWraith's core setup is intentionally small: install or sign in to the
provider runtime you want to use, select a workspace, and choose an approval
posture. This page covers the optional features that may need external accounts,
system permissions, or app-specific setup.

None of these are required for normal chat or for workspace review, file edits,
git review, Diff Studio, and TaskWraith-owned tool parity on qualified
tool-capable providers.

## Quick Map

| Feature | External setup | Maturity |
| --- | --- | --- |
| Ollama local models | Install Ollama and pull at least one supported model. | Supported optional path |
| Kimi | Use `kimi login` (device-code OAuth) or configure a provider key directly in `~/.kimi-code/config.toml`. The key saved in TaskWraith Settings is usage-query-only and is not supplied to ACP. Credentials do not qualify the runtime, and there is no non-ACP fallback. | Setup supported; structural ACP admission runs in every build, with unreviewed admitted runs labelled `unattested-development` |
| Claude API-key mode | Paste an Anthropic API key instead of using Claude Code login. | Supported optional auth mode |
| Cursor | Install `cursor-agent` and run `cursor-agent login`. | Supported live provider; current Path-B route has native and TaskWraith tools |
| Image generation | Enable the tool and paste an OpenAI or xAI image API key. | Optional, off by default |
| iOS Remote | Install the companion app, pair it with the Mac, optionally add Tailscale for off-LAN access. | Working beta / TestFlight phased |
| Screen Watch | Grant macOS window/screen capture permission when attaching a window. | Optional advanced surface |
| Simulator Canvas | Optional Xcode / Simulator.app (never auto-installed). | Optional advanced surface |
| Discord Context | Bot token and guild IDs for read-only composer context. | Supported optional context attachment |
| Creative app automation | Install Final Cut Pro, Logic Pro, or Blender and approve macOS Automation prompts. | Super experimental / WIP |
| Custom external MCP servers | Add, import, validate, and export definitions in Settings -> Integrations -> MCP Servers. | Supported advanced surface |

## Ollama Local Models

Ollama lets TaskWraith run local models without a cloud account. Install Ollama,
start it, then pull a model. The same commands are shown in TaskWraith's
first-launch sheet and Settings provider setup.

Install Ollama:

```sh
# macOS / Linux
curl -fsSL https://ollama.com/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://ollama.com/install.ps1 | iex
```

Then run one supported model command. `ollama run <model>` downloads the model if
it is missing, starts a local chat session, and leaves the model available for
TaskWraith afterward. Once the download completes, you can exit the terminal
session with `/bye` or close it.

```sh
ollama run qwen3:4b-instruct
ollama run qwen3.5:9b
ollama run qwen3.6:35b
ollama run gemma4:12b
ollama run gpt-oss:20b
ollama run minicpm-v4.5:8b
ollama run granite4.1:3b
ollama run granite4.1:30b
ollama run nemotron3:33b
```

For a first test, start with a smaller model such as `qwen3:4b-instruct` or
`granite4.1:3b`. Larger models need more disk, RAM, and patience.

Ollama uses the same permission presets as cloud providers. Start in
Ask or Plan workflow; file edits, shell commands, network tools,
delegation, and publishing follow the selected permission posture and approval
policy. The Ollama run profile controls local-model prompting/runtime behavior,
not a separate safety-tier ladder.

## API Keys

Some optional providers and tools use API keys instead of, or in addition to,
CLI login. Kimi Code ACP can use the current credential created by `kimi login`
or a provider key configured directly in `~/.kimi-code/config.toml`.

- **Kimi:** run `kimi login` and complete the device-code OAuth flow, or configure
  a provider key in Kimi Code's own `~/.kimi-code/config.toml`. The encrypted
  Moonshot key field in TaskWraith Settings is used only for the usage query; it
  is not projected into managed ACP. Credentials do not qualify a binary for
  managed execution, and TaskWraith offers no legacy Wire/print fallback.
- **Claude API-key mode:** paste an Anthropic API key in **Settings → AI &
  Providers → Providers → Claude**. This takes priority over the Claude Code login session and uses
  API/PAYG billing.
- **Image generation:** open Settings -> Integrations -> Provider Tools,
  enable `image_generate`, choose OpenAI or xAI Grok, and save the matching API
  key.

TaskWraith stores these keys through platform secure storage on the computer. If
secure storage is unavailable, API-key save controls refuse to store new keys.

### Prompt caching

Open **Settings → AI & Providers → Providers → Prompt caching** to review guarantee badges
(Guaranteed / Automatic / Best effort / Unsupported), any transport-supported
mode controls, and recent cache diagnostics when reported. In the current
source, the live Claude and Kimi runtime paths are classified as opaque CLI/SDK
transports: **Best effort**, with no TaskWraith-controlled cache mode. Saving an
API key does not by itself make either path Guaranteed.

Important limits:

- **Codex** is **Automatic / observed**: caching is provider-managed, and
  TaskWraith records hits only when Codex reports them; it cannot force cache
  breakpoints.
- **Claude Code, runtime-admitted Kimi, and Grok** are **Best effort** opaque
  transports. TaskWraith records cache stats only when emitted and cannot force
  provider-side caching.
- **Cursor** is a **Best effort** opaque CLI: record cache stats only when
  emitted.
- A **Guaranteed** badge is reserved for a transport where TaskWraith actually
  owns and controls the API request; the current Claude/Kimi paths do not meet
  that boundary.
- **Automatic** tiers reflect provider-managed implicit caching observed in
  usage metadata, not TaskWraith-managed breakpoints.
- Caching affects cost/latency on repeated stable prefixes; it does not replace
  approval policy or workspace safety.

Full detail: [Session and Workspace — Prompt caching](SESSION_AND_WORKSPACE.md#prompt-caching-byok-and-api-paths).

## iOS Remote

TaskWraith for iPhone/iPad is a Mac companion, not a standalone AI app. It pairs
with the desktop app so you can monitor runs, approve actions, answer questions,
and inspect selected remote projections under the Mac's policy.

Current status:

- The iOS app is working through TestFlight phases.
- Until App Store approval, TestFlight access is handled privately by the
  maintainer rather than through a public self-serve link.
- Testers can also build the iOS target from this repository with their own
  Apple Developer team.

Basic setup:

1. Install TaskWraith on the Mac.
2. Install the iOS companion through TestFlight or a local build.
3. Open the desktop Devices / Pairing surface.
4. Pair the device using the in-app pairing flow.
5. Choose which workspaces the paired device may access. An empty remote
   workspace allowlist denies iOS-initiated runs.

For local-network use, the phone or iPad needs to reach the Mac on the same
network. For off-LAN use, Tailscale is the preferred path because it avoids
manual port forwarding:

1. Install Tailscale on the Mac and sign in.
2. Install Tailscale on the iPhone or iPad and sign in to the same tailnet.
3. In TaskWraith's bridge networking settings, enable remote access via
   Tailscale.
4. Keep Tailscale running on the phone for off-LAN connections.

Push notifications are optional after pairing. They are useful for wake/alert
flows, but basic paired-device testing should not require users to understand
APNs signing material.

On supported iPhones, in-flight Live Activities are enabled by default after
pairing and can be switched off from the Mac's Notifications settings or iOS
Settings. A connected phone can maintain its card locally; the same Mac-owned
APNs credentials let the Mac update or end it after the relay drops and
push-start one after a grace period while the companion is closed. ActivityKit
must read that card state, so it is not end-to-end encrypted; it is restricted
to the non-sensitive allowlist and hard privacy boundary in
[`PRIVACY.md`](PRIVACY.md) and
[`ios/TaskWraithApp/AppStorePrivacyNotes.md`](ios/TaskWraithApp/AppStorePrivacyNotes.md).

## Screen Watch

Screen Watch is off until you explicitly attach a window. Use it when the agent
needs visual context from a running app, browser, simulator, design tool, or
preview window.

Setup and usage:

1. Click the eye-on-screen control in the composer telemetry row.
2. Select the specific window you want TaskWraith to capture.
3. Approve the macOS screen/window capture prompt if macOS asks.
4. Detach the window when the task is done.

macOS permission names vary by version. If capture fails, check System Settings
-> Privacy & Security for Screen Recording, Screen & System Audio Recording, or
the relevant window-capture permission, then restart TaskWraith if macOS asks.

Captured frames are tool inputs. They may be sent to the active provider as
visual context, so avoid attaching windows that contain secrets, credentials,
private messages, or customer data.

## Simulator Canvas

Simulator Canvas is a chat-owned Canvas dock surface for Apple's iOS Simulator.
It is optional and never auto-installs Xcode or Simulator.app.

### Setup and usage

1. Install Xcode (and open it once so platforms install) if you want local
   Simulator support. TaskWraith does not download or provision Xcode for you.
2. In a chat, open the composer **Canvas** menu and choose **Open Simulator
   Canvas**.
3. Preview uses `simctl` screenshots of a booted device. The dock bezel follows
   the last frame’s width/height when available; a **Stale frame** badge appears
   when the screenshot is older than ~4s. Use the toolbar **Poll** control
   (1s / 1.5s / 2s) to change preview cadence.
4. For human tap/type/swipe drive, install Facebook's **idb** (opt-in; never
   auto-installed):
   - Companion (Homebrew): `brew tap facebook/fb && brew install idb-companion`
   - Client (pip): `pip3 install fb-idb` (Python 3.6+)
   - Confirm with `idb list-targets`. Docs: https://fbidb.io
5. Actuation is ready only when `idb` is on PATH **and** a Simulator controller
   lease is held for the chat. Preview / View & Control alone never invents
   device drive.

### Hybrid ownership (controller lease + session)

Simulator Canvas uses a chat-scoped **hybrid** control model:

- `SimulatorSessionStore` keeps the last screenshot metadata (udid, width,
  height, capturedAt) for coordinate mapping.
- `SimulatorControllerLease` distinguishes human View & Control from a run’s
  controller token. Human bezel gestures need a human lease; mutating
  `simulator_*` MCP tools mint a run lease for the active chat/run.
- `SimulatorHostControl` owns simctl host actions (open / boot / screenshot /
  install / launch / terminate) behind that lease + session pairing.
- `IdbClient` is the opt-in actuation path (tap / type / swipe). Without idb,
  gestures are recorded and deferred — never silently pretended to drive.
- On app quit, `simulatorHostService.dispose()` releases owned Simulator.app /
  booted devices TaskWraith spawned.

Hardware buttons (Home / Lock / Rotate) are not wired yet; the panel footer
notes them as future. A truncated AX dump tool (`simulator_inspect` via
`idb ui describe-all` or similar) is also a follow-up — `IdbClient` does not
expose describe-all today, and adding a full tree would be a larger catalog +
truncation design.

### Agents and policy

- `simulator_status` is prompt-free (read-only capability / device inventory).
- Mutating Simulator Canvas tools stay under the workspace **simulatorCanvas**
  agentic-service policy (Ask / Allow / Deny), like other attended surfaces.

### Unattended / scheduled runs (fork 4B)

Scheduled and other unattended runs do **not** inherit a silent simctl mutate
path from Accept Edits / Full Access:

- Plan-floor / read-only unattended: keep **ask** (timer deny) — no change.
- Elevated unattended **without** an explicit `simulatorCanvas` workspace
  grant: force **ask** so Accept Edits cannot silently boot/install/launch.
- Elevated unattended **with** an explicit `simulatorCanvas` workspace grant:
  **allow** (session grants still auto-approve at the approval gate when the
  signed posture is ask).
- Global **deny** is preserved either way.

Honest residual risk: preview frames come from `simctl`; device control uses
idb when installed and a controller lease is held. Without idb, gestures are
recorded and deferred.

## Discord Context

This surface is optional and should not be part of a first-run setup.

Discord Context is a read-only composer attachment. It can read recent messages
from channels your bot can access, label that content as untrusted context, and
attach it to a TaskWraith prompt. It does not post back to Discord.

Setup requires:

- A Discord bot token.
- At least one Discord server/guild ID.
- Bot permissions to view the channel and read message history.

For local development, configure the values in `.env`. For a packaged macOS app
launched from Finder, use TaskWraith's runtime config file:

```sh
mkdir -p "$HOME/.config/taskwraith"
cat > "$HOME/.config/taskwraith/discord-context.env" <<'EOF'
TASKWRAITH_DISCORD_BOT_TOKEN=your-bot-token
TASKWRAITH_DISCORD_GUILD_IDS=123456789012345678
EOF
```

Restart TaskWraith after changing this file.

## Creative App Automation

Creative app automation is super experimental and still WIP. It is intended for
workflows around apps such as Final Cut Pro, Logic Pro, and Blender.

External setup may include:

- Installing the target creative app.
- Opening a disposable project for testing.
- Approving macOS Automation prompts when TaskWraith asks to control another app.
- Reviewing every generated script, timeline operation, or Blender Python action
  before allowing it to run.

Do not use this path on important production projects until you have tested the
exact workflow on disposable media and understand the approval prompts.

## Custom External MCP Servers

TaskWraith's own tool parity does not require users to install custom MCP
servers manually. Qualified provider runtimes receive the TaskWraith-owned tool
surface through the app's brokered integration. Managed Cursor can use this
built-in gateway alongside its native tools; no manual TaskWraith MCP install is
required.

Custom external MCP servers are managed in the app at **Settings -> Integrations
-> MCP Servers**. You can add stdio, HTTP, or SSE servers; import Claude/Cursor
JSON or Codex TOML snippets; validate readiness; enable or disable servers; and
copy redacted audit or provider config snippets. Provider-owned config files are
still useful when you want to use the same server outside TaskWraith.

Obvious token-like environment variables and headers are stored as encrypted
secret references where platform secure storage is available. Conservative
redaction cannot prove every custom value is harmless, so review imported MCP
configs before enabling them and avoid pasting broad credentials directly into
visible config fields.

Treat third-party MCP servers like command-line tools with network and file
access:

1. Read the server source or vendor docs.
2. Prefer read-only tools first.
3. Avoid broad filesystem roots.
4. Keep provider config changes reviewable.
5. Remove servers you no longer use.

Provider configuration is not itself a TaskWraith approval boundary. Cursor may
load account/project skills, plugins, or MCP under its own account trust — do
not assume TaskWraith mediates every provider-native action merely because the
seat is labelled Read-only. Disable untrusted project servers or use a
disposable workspace outside `$HOME` when that risk matters. Cursor JSON
import/export remains useful for configuration interchange outside TaskWraith
as well.

## Recommended Order

For cautious users, enable optional surfaces in this order:

1. Core provider CLI/API setup in a scratch workspace.
2. Local Ollama testing in Ask or Plan workflow.
3. Optional provider sign-ins and API-key tools such as Kimi or image generation.
4. iOS Remote on the same LAN.
5. Tailscale for off-LAN iOS Remote.
6. Screen Watch on a non-sensitive window.
7. Simulator Canvas after Xcode / Simulator.app is already installed (optional).
8. Discord read-only context.
9. Creative app automation and custom external MCP only after the core workflow
   is familiar.
