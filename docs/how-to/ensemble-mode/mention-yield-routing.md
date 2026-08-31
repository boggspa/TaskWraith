# How to: Mention & Yield Routing

**Platform:** Both

## What it is
In an Ensemble chat, participant mentions and the `ensemble_yield` tool control
which participant speaks next. Directing a composer prompt to one foreground
participant sends only that seat the round; a participant tagging peers in its
own reply promotes every routable target in prompt order, while
`ensemble_yield(target: …)` explicitly hands off to one target. **BG** is the
deliberate exception: mentioning a background-stage participant attempts a
detached launch while foreground rotation continues.

The current source-ahead desktop picker preserves the selected participant's
exact id, while Electron main remains the routing authority. Hand-typed aliases
must identify one enabled seat; an ambiguous alias is rejected before launch
instead of selecting by roster order. This is newer than the v1.8.4 release.

## Where to find it
Type `@` followed by a participant's role or model name in the composer during an ensemble chat — an autocomplete menu lists matching participants. Routing from a participant's own reply happens automatically whenever their response text contains an `@Role` mention or they call the `ensemble_yield` tool; there's no separate control to find for that half.

![Composer showing an @-mention being typed with role autocomplete](../images/ensemble-mode__mention-yield-routing.png)

## How to use it
1. In the composer, type `@` and a few letters of a participant's role,
   provider, or model name (for example `@Researcher` or `@GPT 5.5`). On
   desktop, choose the autocomplete result when you need one exact seat; the
   source-ahead textarea temporarily shows its structured mention markdown and
   the sent transcript renders it as a participant chip. A plain alias is safe
   only when it is unique. The current iOS composer sends alias text, so use a
   unique role/model when same-provider seats collide.
2. Send a prompt directed to exactly one foreground participant to reach only
   that seat for the round. Main validates the target against its current
   roster; a stale picker target or ambiguous hand-typed alias fails before the
   round starts. Mentioning a BG participant does not collapse the panel into a
   DM; it allocates background work and preserves the foreground round.
3. During a round, a participant can tag one or more peers in its reply text
   (`"@Researcher and @Reviewer, check this"`). Every unique, unambiguous
   participant that has not spoken is promoted in prompt order. In Continuous
   mode, an ordinary participant that already answered/yielded is not
   re-summoned; the active Boss—or Captain once the Boss is unavailable—is the
   budget-bounded exception.
4. A participant can call `ensemble_yield` with one optional `target` and
   `reason` to make a single explicit handoff. It uses the same aliases, but an
   unresolved or ambiguous yield target falls through to ordinary ordering;
   ambiguous text mentions instead post a warning. Yielding to `user`, `human`,
   or `you` explicitly returns control in Continuous mode.
   Managed Cursor can call `ensemble_yield` when its TaskWraith tool gateway is
   active. If a turn visibly falls back to native-only operation, use
   @-mention routing from a tool-capable peer or ordinary turn order.
5. If a participant's in-round tagged name matches more than one seat, the
   orchestrator posts an ambiguity notice and leaves routing unchanged. For a
   user/composer direct prompt, main rejects the ambiguous launch instead. Use
   the desktop participant picker or a unique role/model alias.
6. The active authority takes routing priority. If a reply tags the Boss and an
   advisory participant, only the Boss route is applied; once the Boss is
   unavailable, the active Captain receives that priority instead. Explicit
   `@Captains` and `@Management` groups remain collective and do not collapse
   to that single priority seat.
7. A unique `@Background` alias attempts to launch the sole enabled BG seat.
   Concurrent lanes must be enabled, the seat must not already be active, and
   admission/budget checks must pass. With multiple BG seats, `@Background` is
   still ambiguous — use a unique `@Role`, `@Model`, or participant id;
   TaskWraith warns and launches nothing when the alias is ambiguous.
8. **Group tokens address a roster set at once.** Typing `@All`, `@Captains`,
   `@Management`, `@Scouts`, `@Workers`, `@Reviewers`, or `@BG` targets every
   enabled participant in that group rather than one seat. `@Captains` uses the
   configured Captain ids exclusively; `@Management` combines the configured
   Boss and Captains. Display names do not grant authority. The groups appear at
   the top of the `@` menu with a seat count, and a group with no matching
   enabled seats is hidden. Group chips use the host OS accent rather than the
   separate message-bubble or provider colours.
9. **`@BG` is a group token, not a seat alias** — it expands to *every* enabled
   background seat and is never ambiguous. This is a change: it previously
   named a single BG seat and warned when more than one matched. `@Background`
   was not changed and still means one seat, so the two are no longer
   interchangeable.
10. When *you* use a group token it always applies. When a *participant* writes
    one mid-round it only fans out if that seat holds Boss or Captain fan-out
    authority; otherwise the round status says so and no turns are appended.
    Only the exact plurals `@Captains` and `@Management` are authority groups;
    singular `@Captain` and `@Manager` stay ordinary participant aliases.

## Tips & related
- [Continuous Hops Meter](continuous-hops-meter.md) — the continuation-turn budget consumed by explicit handoffs and autonomous Continuous passes.
- [Participant Chip Strip](participant-chip-strip.md) — shows each participant's role/model name, which is what you type after `@`.
- [Create an Ensemble Chat](create-ensemble-chat.md) — set up a chat with multiple participants before routing between them.
- [Round Cards in Transcript](round-cards.md) — see how yields and mention-promotions are noted in the round's transcript.
