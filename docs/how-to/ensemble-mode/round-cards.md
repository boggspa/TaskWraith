# How to: Round Cards in Transcript

**Platform:** Electron

## What it is
In Ensemble chats, completed rounds can fold into collapsible "round cards" instead of staying fully expanded in the transcript. A collapsed card shows the round number, the providers/roles that spoke, a message count, and a one-line summary; clicking it reveals the round's full messages again.

## Where to find it
Round cards appear automatically in the transcript of any Ensemble chat. The feature is controlled by **Settings → General → "Collapse older Ensemble rounds"**.

![Ensemble transcript showing collapsed round cards](../images/ensemble-mode__round-cards.png)

## How to use it
1. Open an Ensemble chat and run a few rounds — once a round completes, it collapses into a round card automatically (the most recent round, and any round currently in progress, always stay expanded).
2. Click a round card's header (or its chevron) to expand it and read the full transcript for that round; click again to collapse it.
3. To stop rounds from auto-collapsing and always see the full flat transcript, go to **Settings → General** and turn off **"Collapse older Ensemble rounds"**.
4. Manual expand/collapse choices apply only to the current chat session — they reset when you switch chats.

## Tips & related
- [Create an Ensemble Chat](create-ensemble-chat.md) — start a multi-agent conversation that produces rounds.
- [Fan-Out Toggle](fan-out.md) — controls how many participants respond per round.
- [Continuous Hops Meter](continuous-hops-meter.md) — tracks ongoing exchanges across rounds.
- [Participant Chip Strip](participant-chip-strip.md) — shows who's in the round before it starts.
