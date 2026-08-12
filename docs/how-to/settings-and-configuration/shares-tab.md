# How to: Channels tab

**Platform:** Electron

## What it is
The Channels tab is the global overview of every channel this Mac hosts or has joined — and the revoke/close authority of last resort. Each channel shows its members and their live connection state, plus host controls to revoke a member, close the channel, or review its audit trail. Per-chat sharing controls (fresh invites, admissions, message review) live in each chat's own Channel panel; member messages are host-reviewed, and nothing posts into the transcript until you approve it.

## Where to find it
**Settings → Integrations → Channels**

<!-- screenshot-pending: Channels tab showing hosted channel list with member and revoke controls -->

## How to use it
1. Open **Settings → Integrations → Channels** to see every channel you host or belong to.
2. Each channel shows its chat, its members with live connection state, and any open admissions. The member ceiling (eight) counts humans and agent seats together.
3. To share a chat or issue a fresh invite, open that chat's own **Channel panel** — invites and admissions are per-chat, not created from this tab.
4. Review member messages from the host review queue in the chat's Channel panel: **Approve** posts the member's message into the transcript as an external, untrusted row; **Decline** drops it.
5. Use **Remove** next to a member to revoke just their access, or close the whole channel to revoke everyone at once.
6. A channel is reachable only while the host Mac is online.

## Tips & related
- Members connect over your remote-access relay, so make sure remote access is enabled on the [Devices tab](devices-tab.md) before sending an invite.
- Join a channel by pasting an invite into **Join a Channel** in a chat's Channel panel.
- [Chat types](../chats-and-threads/chat-types.md) — where channels fit among the chat types.
