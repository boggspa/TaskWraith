# Import an external provider thread

**Platform:** Electron

## What it is
Bring a saved Codex, Claude, Cursor, or AntiGravity transcript into TaskWraith as a read-only archived copy, so you can search and re-read it here. It is a snapshot for reading, not a live session you can carry on.

<!-- screenshot-pending: Settings → Archived showing the Import an external provider thread panel -->

## Where to find it
**Settings → Data → Archived**, in the **Import an external provider thread** panel.

## How to use it
1. Turn on local chat history first, or the import has nowhere to be saved.
2. Open **Settings → Data → Archived** and find **Import an external provider thread**.
3. Pick the source provider from the dropdown.
4. Click **Choose transcript file…** and select one `.json` or `.jsonl` file.
5. Check the new row in the archived list, and unarchive it only if you want it in the sidebar.

## Tips & related
- TaskWraith never scans provider folders on its own. You pick one file per import, and its path is not saved.
- Only your messages and the assistant's replies come across. Tool calls, tool results, attachments, and hidden reasoning are dropped.
- Imported messages are marked as untrusted and are left out of future prompts, so an agent never quietly treats them as its own history.
- The chat keeps whichever provider TaskWraith is set to run. The original provider is recorded as history only.
- To reuse something from an import, select the text, use **Add to prompt** or copy it, read what lands in the composer, then send it yourself.
- Limits per import: 16 MB file, 2,000 messages, 100,000 characters per message, 4 MB of text. Importing the same file twice reuses the existing chat.
