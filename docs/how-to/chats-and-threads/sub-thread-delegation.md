# How to: Sub-Thread Delegation

**Platform:** Electron

## What it is
Sub-thread delegation starts a linked child chat under a parent chat and hands part of the work to a fresh agent. The child can use the same provider as its parent or a different one. You can start one from the sidebar, or an agent can start one during its turn. When the child finishes, its result appears as a card in the parent chat.

## Where to find it
Open a chat's overflow menu in the sidebar and choose **Delegate to a sub-thread**. An agent can also start one during its turn. Agent-started requests use your approval settings: the default **Ask** option shows an approval prompt first. No child is created if you decline.

<!-- screenshot-pending: Sub-thread delegation card and return card in a chat transcript -->

## How to use it
1. In the sidebar, open the overflow menu on a chat and select **Delegate to a sub-thread**.
2. Pick a provider and write the prompt describing the work to hand off.
3. Leave **Return result to parent on completion** checked to get the child's result back as a card in the parent chat.
4. Confirm. The sub-thread uses the parent's workspace and appears under the parent in the sidebar.
5. Open the child from the sidebar. On an agent-started card, **Open beside** / **Open drawer** shows it next to the parent, while **Open main** switches to it.
6. Sub-threads can only go one level deep — to branch again, return to the parent chat and start another sub-thread.

## Tips & related
- [Chat Types](chat-types.md) — how sub-threads fit alongside workspace, ensemble, and side chats.
- [Side Chat](side-chat.md) — the "Open beside"/"Open drawer" panel is the same side-panel mechanism used for side chats.
- [Pinned Messages](pinned-messages.md) — pin a delegation or return card to keep it handy in the transcript.
