# How to: Sub-thread status ticker

**Platform:** Electron

## What it is
`SubThreadStatusTicker` is an implemented renderer component intended to list a
parent chat's active sub-threads. It is not mounted by the current desktop UI,
including v1.8.4 and this source-ahead checkout, so the inline ticker described
by the component is not presently available to users.

## Where to find it
There is no mounted ticker to open today. Use the nested child row in the
sidebar, agent-driven delegation/return cards in the parent transcript, or open
the child chat directly to inspect its status.

## How to use it
1. Delegate work from a parent chat; the child appears nested beneath it in the
   sidebar.
2. For an agent-driven delegation, use the transcript card to open the child
   beside the parent or as the main chat. Manual sidebar delegation currently
   has no parent transcript delegation card, so open the nested sidebar row.
3. Watch the child row/chat for live state. A typed terminal return card appears
   in the parent when result return is enabled.
4. Treat any future inline ticker as pending product work until the component is
   mounted and covered by an integration test.

## Tips & related
- [Sub-Thread Delegation](../chats-and-threads/sub-thread-delegation.md) — how sub-threads get created in the first place.
- [Side Chat](../chats-and-threads/side-chat.md) — a related but separate kind of linked chat.
- [Participant health](participant-health.md) — status cards for ensemble participants.
- [Provider health chips](provider-health-chips.md) — connectivity/model-load state chips.
