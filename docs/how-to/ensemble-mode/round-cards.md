# How to: Round Cards in Transcript

**Platform:** Electron

## What it is
In Ensemble chats, completed rounds can fold into collapsible "round cards" instead of staying fully expanded in the transcript. A collapsed card shows the round number, the providers/roles that spoke, a message count, and a one-line summary; clicking it reveals the round's full messages again.

## Where to find it
Round cards appear automatically in the transcript of any Ensemble chat. The feature is controlled by **Settings → General → "Collapse older Ensemble rounds"**.

![Manually expanded completed Ensemble round showing participant handoff activity and its close-out card](../images/ensemble-mode__round-cards.png)

## How to use it
1. Open an Ensemble chat and run a few rounds. A live round always stays flat and visible. Completed rounds collapse automatically once their close-out is present; the latest idle round can remain expanded until that close-out arrives.
2. Click a round card's header (or its chevron) to expand it and read the full transcript for that round; click again to collapse it.
3. To stop rounds from auto-collapsing and always see the full flat transcript, go to **Settings → General** and turn off **"Collapse older Ensemble rounds"**.
4. Manual expand/collapse choices survive chat switches and transcript remounts within the current app session. They reset when the app is relaunched.

## Tips & related
- [Create an Ensemble Chat](create-ensemble-chat.md) — start a multi-agent conversation that produces rounds.
- [Fan-Out Toggle](fan-out.md) — controls how many participants respond per round.
- [Continuous Hops Meter](continuous-hops-meter.md) — tracks ongoing exchanges across rounds.
- [Participant Chip Strip](participant-chip-strip.md) — shows who's in the round before it starts.
