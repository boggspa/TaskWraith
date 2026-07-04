# How to: Provider, Model, and Permissions Pickers

**Platform:** Electron

## What it is
These are the three chips on the composer's controls row that decide how your next message runs: which **provider** (Codex, Claude, Kimi, Grok, Cursor, or a local Ollama model) handles it, which **model** and **reasoning effort** it uses, and what **permission preset** it's allowed (Plan, Read-only/Recon, Default Approval, or Full Workspace Access).

In a normal top-level chat, these pickers stay usable even after the thread has
history. If the chat is idle, changes apply immediately. If a turn is already
running, provider/model/reasoning changes queue on the thread and the UI shows
that they will apply at turn end.

## Where to find it
In the **composer's inline pickers row**, just below the prompt input. Each control is its own chip: the **provider chip** (leftmost), the **model + reasoning chip** showing the current model name, and the **permissions chip** showing the active preset (with a grant count, e.g. "2 grants", when tool grants are on). In an ensemble chat with a participant selected, these chips edit that participant instead of the whole chat.

<!-- screenshot-pending: Composer inline pickers row with provider, model+reasoning, and permissions chips -->

## How to use it
1. Click the **provider chip** to open a list of available providers and pick one — only providers you've enabled (and Grok/Cursor only if available) are shown, with a checkmark on the active one.
2. Click the **model chip** to open a two-column popover: **Model** on the left, **Reasoning** on the right (for Ollama, a **Provider** column appears too, since one chip covers many local models).
3. Pick a model in the left column — disabled or retiring models show a reason or a retirement date pill.
4. Pick a reasoning effort in the right column (e.g. Low/Medium/High/Extra High for Codex, or Extra/Max/Ultracode for Claude). For Codex and Claude models that support it, toggle **Fast mode** at the bottom of the Reasoning column for the paid fast tier.
5. Click the **permissions chip** to open the Permissions popover. Choose **Plan**, **Read-only (recon)**, **Default Approval**, or **Full Workspace Access** on the left; if a workspace is active, toggle individual **Tool Grants** on the right. Plan and Read-only/Recon both keep ordinary tools read-only, but Plan can save the narrow markdown plan artifact used by proposed-plan cards.
6. Moving to a higher-trust preset (e.g. Default → Full Workspace Access) may show a one-time elevation warning before it applies.
7. If a normal chat is currently running, provider/model/reasoning changes do
   not interrupt that in-flight turn. The picker keeps your latest selection and
   the change applies at turn end. A same-provider model/reasoning change keeps
   the current linked session; a genuine provider switch resets provider-linked
   session state before the next turn.

## Tips & related
- [Plus Tools Menu](plus-tools-menu.md) — sits at the start of the same action row as these pickers.
- [Ensemble Mode Picker](ensemble-mode-picker.md) — when these pickers edit a selected participant instead of the chat.
- [Providers tab](../settings-and-configuration/providers-tab.md) — sign in to providers and manage agentic service policies that back the Tool Grants column.
- [Saved Roster Presets](../ensemble-mode/saved-roster-presets.md) — save a participant's provider/model/permissions combo for reuse.
