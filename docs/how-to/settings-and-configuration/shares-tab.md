# How to: Shares tab

**Platform:** Electron

## What it is
The Shares tab lists chats you've shared with human collaborators. Each entry shows the share's access mode, its participants and their connection status, any open invites, and lets you stop the share or remove a single collaborator.

## Where to find it
**Settings → Integrations → Shares**

<!-- TODO(screenshot): Shares tab showing collaborator list and access controls -->

## How to use it
1. Open **Settings → Integrations → Shares** to see every chat you currently have shared.
2. Each card shows the chat title, its access mode (**Read-only** or **Comments**), and whether a collaborator is currently connected (**Live** / **Not connected**).
3. Click **Copy invite** to generate a fresh out-of-band invite for that share — paste it to the collaborator yourself.
4. Under a card's participant list, click **Remove** next to a collaborator to revoke just their access.
5. Click **Stop sharing** to revoke the whole share immediately; all collaborators lose access at once.

## Tips & related
- Collaborators connect over your remote-access relay, so make sure remote access is enabled on the [Devices tab](devices-tab.md) before sending an invite.
- [Shares popover](../footer-control-row/shares-popover.md) — quick glance at active shares from the sidebar footer.
- Start a new share from a chat's share action or the sidebar's "+ New" menu ("New Shared Chat" / "Join Shared Chat").
