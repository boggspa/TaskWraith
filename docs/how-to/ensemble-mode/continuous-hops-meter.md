# How to: Continuous Hops Meter

**Platform:** Electron

## What it is
The `n/m` chip counts continuation turns in an Ensemble round: how many have
been used, out of the limit you set. `2/6` means two of six are gone. Recalling
an eligible participant for an extra turn consumes one hop, and an automatic
new pass reserves one hop for each admitted seat. Advancing or promoting a seat
already waiting in the serial queue consumes no additional hop. A quiet Boss
response follows that queue instead of spending a hop to run the Boss again.

## Where to find it
In the **Turns** cell on the second row of the Roster Presets section above the composer, beside **Fan-Out** and **Isolate**.

![Continuous hops meter chip showing "2/6" in the Turn Budget cell](../images/ensemble-mode__continuous-hops-meter.png)

## How to use it
1. Watch the chip while a round runs — the first number climbs as agents hand work on.
2. Click the chip to open **Max handoff turns**.
3. Type a new limit between 1 and 1200 and click **Set**.
4. The new limit takes effect at once, including on a round that is already running.

## Tips & related
- Set a low limit to keep a round short — roughly one pass around the roster and done.
- The count itself is read-only; only the limit can be changed.
- [Mention & Yield Routing](mention-yield-routing.md) — how handoffs are triggered.
- [Create an Ensemble Chat](create-ensemble-chat.md) — start an ensemble chat.
- [Fan-Out Toggle](fan-out.md) — the parallel-lanes control beside this chip.
- [Round Cards in Transcript](round-cards.md) — how a round's handoffs appear in the transcript.
