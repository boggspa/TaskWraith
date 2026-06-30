# How to: In-Chat Search

**Platform:** Electron

## What it is
In-chat search finds text within the currently open chat's transcript — messages, tool activity, and metadata — and lets you step through the matches one at a time.

## Where to find it
In any chat, press **⌘F** to open the search bar above the transcript. This is separate from **⌘⇧F**, which searches workspaces and threads in the sidebar instead.

<!-- TODO(screenshot): In-chat search bar with highlighted results in the transcript -->

## How to use it
1. Press **⌘F** to open the search bar for the current chat.
2. Type your query — it matches message text, labels (You/Assistant/Tool/System/Error), and tool activity details, case-insensitively.
3. Press **Enter** (or click **↓**) to jump to the next match; **Shift+Enter** (or click **↑**) to jump to the previous one. The bar shows your position, e.g. "2 / 5".
4. The transcript scrolls to and selects the matching message.
5. Press **Escape** (or click the close button) to dismiss the search bar.

## Tips & related
- [Sidebar search](../sidebar-navigation/sidebar-search.md) — search across workspaces and threads instead of one transcript.
- [Transcript message stream](../transcript-and-search/transcript-message-stream.md) — the scrolling view that search results jump to.
- [Chat types](chat-types.md) — in-chat search works within whichever chat type is currently open.
