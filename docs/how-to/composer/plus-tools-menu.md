# How to: Plus Tools Menu

**Platform:** Electron

## What it is
The Plus Tools menu is the composer's "+" popover for adding context to a message — file/image and folder attachments, an attached app window for Screen Watch, and Discord channel context — plus quick links to workspace and command tools like Diff Studio, Models, Slash Commands, and Review diff.

## Where to find it
Click the **+ button** at the start of the composer's action row (next to the prompt input, identified by the plus icon). The popover opens grouped into sections: **Add**, **Workspace**, and **Commands**.

![Composer + tools menu expanded showing attachments, multiview, screen watch](../images/composer__plus-tools-menu.png)

## How to use it
1. Click the **+** button to open the popover.
2. Under **Add**, choose:
   - **Attachment** — opens a file picker (multi-select, any file type) and adds the selected files as attachments, up to 15 at a time.
   - **Folder** — attaches a folder reference; the agent receives scoped reads of that folder's contents, carried through solo and Ensemble runs.
   - **Attach app / Detach app** — pick a running app window to watch (Screen Watch), or detach/stop a live capture already in progress.
   - **Discord context** — pull recent messages from a Discord channel into the chat's context (only available once a chat is selected).
3. Under **Workspace**, open **Status** (provider safety/setup), **Diff Studio** (workspace changes), or **Models** (capability state) in the Inspector panel.
4. Under **Commands**, open the **Slash commands** menu or trigger **Review diff** (a read-only, plan-mode review of the current changes).

## Tips & related
- [Provider, Model, and Permissions Pickers](provider-model-permissions-pickers.md) — the other composer pickers next to the + button.
- [Slash Commands](slash-commands.md) — full reference for the slash command menu opened from Commands.
- [Inspector Panel](../transcript-and-search/inspector-panel.md) — where Status, Diff Studio, and Models open.
- [Proposed Plan Cards](../transcript-and-search/proposed-plan-cards.md) — what a Review diff plan-mode pass produces.
