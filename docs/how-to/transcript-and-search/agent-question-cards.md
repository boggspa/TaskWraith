# How to: Agent question cards

**Platform:** Both

## What it is
An agent question card is an inline prompt that appears in the transcript when an agent calls the `ask_user_question` tool mid-run to ask you something directly — a clarifying question, or a choice between a few options — instead of guessing and continuing.

Source-ahead Cursor cannot create this card or participate in a new run because
TaskWraith starts no managed Cursor process. Historical question content remains
readable.

## Where to find it
The card appears automatically in the transcript, anchored next to the system message marking the question, whenever a participant asks one. You don't navigate to it — it surfaces inline in the chat you're already viewing, on both Electron and iOS.

<!-- screenshot-pending: Agent question card inline in the transcript -->

## How to use it
1. When a card appears, read the question (and any extra context shown below it).
2. If the agent offered options, click one to answer immediately.
3. If you want to answer in your own words, click **Other…** (or, on iOS, type directly into the answer field) and enter free text.
4. Submit your answer — on Electron, use ⌘/Ctrl+Enter in the text box or click **Send answer**; the answer also appears as your next message in the transcript.
5. To skip without answering, dismiss the card with the **×** button or Escape — the agent's tool call resolves as cancelled and it continues without your input.
6. If you leave a question untouched, it automatically expires after 10 minutes and the agent is told the question timed out.

## Tips & related
- [Pending Approval Modal](../approvals-and-permissions/pending-approval-modal.md) — a related in-transcript prompt, but for approving tool actions rather than answering questions.
- [Proposed Plan Cards](proposed-plan-cards.md) — another inline transcript card, shown when an agent proposes a plan for approval.
- [Transcript Message Stream](transcript-message-stream.md) — the scrolling view these cards render inside.
- [iOS Ensemble UI](../ensemble-mode/ios-ensemble-ui.md) — how inline cards like this behave in TaskWraith's iOS transcript.
