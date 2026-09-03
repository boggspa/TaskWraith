# How to: Mention & Yield Routing

**Platform:** Both

## What it is
In an Ensemble chat, `@` mentions and the `ensemble_yield` tool control
which participant speaks next. Send a composer prompt to one participant to reach only that seat; a participant tagging peers in its own reply brings each named seat in, while
`ensemble_yield(target: …)` hands off to one target. **BG** is the
exception: mentioning a background participant starts detached background work while the normal round continues.

Type `@` plus a name that matches exactly one enabled seat. If a name matches more than one seat, TaskWraith warns and routing stays unchanged instead of guessing.

## Where to find it
Type `@` followed by a participant's role or model name in the composer during an ensemble chat — an autocomplete menu lists matching participants. Routing from a participant's own reply happens automatically whenever their response text contains an `@Role` mention or they call the `ensemble_yield` tool; there's no separate control for that half.

![Composer showing an @-mention being typed with role autocomplete](../images/ensemble-mode__mention-yield-routing.png)

## How to use it
1. In the composer, type `@` and a few letters of a participant's role,
   provider, or model name (for example `@Researcher`). Pick the autocomplete result when you need one exact seat. A plain typed name is safe only when it matches one seat; on iOS, where the composer sends plain text, always use a unique role or model name.
2. Send a prompt addressed to exactly one participant to reach only
   that seat for the round. Mentioning a BG participant does not narrow the round; it starts background work and keeps the normal round going.
3. During a round, a participant can tag one or more peers in its reply text
   (`"@Researcher and @Reviewer, check this"`). Each named seat that has not spoken is added in the order named. In Continuous
   mode, a participant that already answered is not
   called again; the active Boss — or Captain once the Boss is unavailable — is the
   exception.
4. A participant can call `ensemble_yield` with one optional `target` and
   `reason` to make a single explicit handoff. An unclear yield target falls through to normal ordering.
   Yielding to `user`, `human`,
   or `you` returns control to you.
   Managed Cursor can call `ensemble_yield` when its TaskWraith tool gateway is
   active. If a turn visibly falls back to native-only operation, use
   @-mention routing from a tool-capable peer or normal turn order.
5. The active Boss takes routing priority: if a reply tags the Boss and another
   participant, only the Boss route is applied; once the Boss is
   unavailable, the active Captain gets that priority instead.
6. **Group tokens address a set at once.** Typing `@All`, `@Captains`,
   `@Management`, `@Scouts`, `@Workers`, `@Reviewers`, or `@BG` targets every
   enabled participant in that group rather than one seat. The groups appear at
   the top of the `@` menu with a seat count, and a group with no matching
   enabled seats is hidden. When *you* use a group token it always applies; when a *participant* writes
   one mid-round it only fans out if that seat holds Boss or Captain fan-out
   authority, otherwise the round status says so and no turns are added.
   `@BG` expands to *every* background seat and is never ambiguous; `@Background`
   still names one seat, so the two are not interchangeable.

## Tips & related
- [Continuous Hops Meter](continuous-hops-meter.md) — the continuation-turn budget consumed by explicit handoffs and autonomous Continuous passes.
- [Participant Chip Strip](participant-chip-strip.md) — shows each participant's role/model name, which is what you type after `@`.
- [Create an Ensemble Chat](create-ensemble-chat.md) — set up a chat with multiple participants before routing between them.
- [Round Cards in Transcript](round-cards.md) — see how yields and mention-promotions are noted in the round's transcript.
