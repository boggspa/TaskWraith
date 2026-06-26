# Advanced Optional Setup

<p align="center">
  <img src="design-assets/ghost/ghost-guy-mark-monoline.svg" alt="TaskWraith monoline mark" width="72" />
</p>

TaskWraith's core setup is intentionally small: install or sign in to the
provider runtime you want to use, select a workspace, and choose an approval
posture. This page covers the optional features that may need external accounts,
system permissions, or app-specific setup.

None of these are required for normal chat, workspace review, file edits, git
review, Diff Studio, or TaskWraith-owned tool parity.

## Quick Map

| Feature | External setup | Maturity |
| --- | --- | --- |
| Ollama local models | Install Ollama and pull at least one supported model. | Supported optional path |
| Kimi | Paste a Moonshot API key. | Supported optional provider |
| Claude API-key mode | Paste an Anthropic API key instead of using Claude Code login. | Supported optional auth mode |
| Image generation | Enable the tool and paste an OpenAI or xAI image API key. | Optional, off by default |
| iOS Remote | Install the companion app, pair it with the Mac, optionally add Tailscale for off-LAN access. | Working beta / TestFlight phased |
| Screen Watch | Grant macOS window/screen capture permission when attaching a window. | Optional advanced surface |
| Discord / message bridges | Bot tokens, Matrix credentials, iMessage permissions, or local bridge setup. | Mixed: Discord context is usable; channel bridges are unfinished/gated |
| Creative app automation | Install Final Cut Pro, Logic Pro, or Blender and approve macOS Automation prompts. | Super experimental / WIP |
| Custom external MCP servers | Configure them in the provider's own config files. | Provider-owned/manual |

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

TaskWraith's Ollama tool access is tiered. Read-only local-model use is the
safest starting point; shell commands and file edits require higher tool tiers
and approval policy.

## API Keys

Some optional providers and tools use API keys instead of, or in addition to,
CLI login.

- **Kimi:** paste a Moonshot API key in Settings -> Providers -> Kimi.
- **Claude API-key mode:** paste an Anthropic API key in Settings -> Providers
  -> Claude. This takes priority over the Claude Code login session and uses
  API/PAYG billing.
- **Image generation:** open Settings -> MCP servers and TaskWraith tools,
  enable `image_generate`, choose OpenAI or xAI Grok, and save the matching API
  key.

TaskWraith stores these keys encrypted on the Mac when platform secure storage
is available. If secure storage is unavailable, the image-generation settings
will refuse to save a key.

## iOS Remote

TaskWraith for iPhone/iPad is a Mac companion, not a standalone AI app. It pairs
with the desktop app so you can monitor runs, approve actions, answer questions,
and inspect selected remote projections under the Mac's policy.

Current status:

- The iOS app is working through TestFlight phases.
- Until App Store approval, users can request to be added as TestFlight testers.
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

## Discord And Message Bridges

These surfaces are optional and should not be part of a first-run setup.

### Discord Context

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

### Message Bridges

The broader message/channel bridge surface is unfinished and gated. Treat it as
developer-preview infrastructure, not a normal user setup path.

Current adapter directions include:

- **Telegram:** create a bot with BotFather and set
  `TASKWRAITH_TELEGRAM_BOT_TOKEN` before launching TaskWraith.
- **Matrix:** set `TASKWRAITH_MATRIX_HOMESERVER_URL` and
  `TASKWRAITH_MATRIX_ACCESS_TOKEN` before launching TaskWraith.
- **iMessage:** local experimental access may require macOS Full Disk Access and
  Automation permissions, followed by an app restart.
- **Local web:** self-hosted/local control surface for development.

Use exact contact allowlists and scratch workspaces while testing. Inbound
messages should be treated as external/untrusted context.

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
servers manually. Supported provider runtimes receive the TaskWraith-owned tool
surface through the app's brokered integration, and write-capable Cursor/Grok
runs auto-inject a scoped broker when needed.

Custom external MCP servers are different: they are provider-owned/manual today.
Configure them in the provider's own MCP config files and provider UI. The
TaskWraith Settings surface can audit known tool surfaces, but custom server
editing is not wired yet.

Treat third-party MCP servers like command-line tools with network and file
access:

1. Read the server source or vendor docs.
2. Prefer read-only tools first.
3. Avoid broad filesystem roots.
4. Keep provider config changes reviewable.
5. Remove servers you no longer use.

## Recommended Order

For cautious users, enable optional surfaces in this order:

1. Core provider CLI/API setup in a scratch workspace.
2. Local Ollama read-only model testing.
3. Optional API-key tools such as Kimi or image generation.
4. iOS Remote on the same LAN.
5. Tailscale for off-LAN iOS Remote.
6. Screen Watch on a non-sensitive window.
7. Discord read-only context.
8. Message bridges, creative app automation, and custom external MCP only after
   the core workflow is familiar.
