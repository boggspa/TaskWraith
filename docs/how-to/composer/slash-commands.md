# How to: Slash Commands

**Platform:** Electron

## What it is
A searchable menu in the composer that lists your provider's own commands (like `/status`, `/model`, `/diff`), TaskWraith's actions (like `/goal`, `/files`, `/settings`), and prompt templates (like `/explain`, `/test`). Picking one either runs it or drops text at your cursor.

## Where to find it
In the chat composer. Type `/` at the start of a word, press **⌘K** (Ctrl+K on Windows and Linux), or open the **+** menu and choose **Slash commands**.

![Composer slash command menu open with available commands](../images/composer__slash-commands.png)

## How to use it
1. Open the menu with `/`, **⌘K**, or the **+** menu.
2. Keep typing to filter by name or description.
3. Press **Arrow Up/Down** to move, then **Enter** or **Tab** to pick — or just click.
4. Add an argument after the name where one is needed, such as `/goal pause` or `/settings providers`.
5. Press **Escape** or click away to close without picking anything.

## Tips & related
- **Provider commands** vary by provider — Codex offers `/status`, `/model`, `/fast`, `/diff`, `/mcp`, `/review`, `/resume`, `/fork`, and `/permissions`.
- **TaskWraith actions** include `/goal`, `/plan`, `/clear`, `/attach`, `/screen`, `/schedule`, `/terminal`, `/canvas`, `/multiview`, `/stop`, `/copy-transcript`, `/files`, `/editor`, `/side`, `/help`, and `/settings`.
- **In an Ensemble** you also get `/ensemble` (on/off), `/ensemble-fanout`, `/ensemble-hops`, `/ensemble-reflect`, `/ensemble-skip`, `/ensemble-skip-reads`, `/ensemble-steer`, `/blackboard`, and `/discuss`.
- **Templates** like `/compact`, `/explain`, `/test`, and `/review-diff` write prompt text for you instead of running an action.
- [Plus Tools Menu](plus-tools-menu.md) — the popover whose **Slash commands** entry opens this menu.
- [Goal Button](goal-button.md) — `/goal` does the same job as the button.
