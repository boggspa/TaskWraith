// Inline ask_user_question card — the iOS mirror of the desktop AgentQuestionCard
// and AgentQuestionTombstoneCard.
//
// The Mac projects the question as `row.agentQuestion` (RemoteThreadProjection
// buildAgentQuestion); ThreadRowView branches here so the question renders INLINE
// in the transcript (anchored to its asking message) instead of only in the top
// attention banner.
//
// The answer round-trip is UNCHANGED. While the question is still open it lives
// in `model.questions` (the parked-tool registry envelope), so we render the
// existing self-contained `QuestionRow` against that live card — model.answer /
// rejectQuestion resolve the same parked tool the banner did.
//
// ONCE IT IS OVER we no longer collapse to a muted one-line "resolved" hint. That
// left the question's options invisible and the user's own answer stranded in a
// separate bubble below, so nothing showed WHICH option had been picked. The
// settled card reports the whole decision, matching the desktop.
//
// WHO DECIDES "SKIPPED": the Mac only tells us `answered` vs `unanswered`,
// because from the transcript it cannot separate an open question from a
// dismissed or timed-out one — none of the three append a message. This device
// can: a question absent from `model.questions` is no longer parked, so an
// `unanswered` question with no live card was abandoned.

import Foundation
import SwiftUI
import TaskWraithKit

struct AgentQuestionRow: View {
    @ObservedObject var model: RemoteSessionModel
    let question: RemoteThreadSnapshot.Row.AgentQuestion

    private var promptId: String { question.promptId ?? "" }

    /// The live parked-tool card while the question is open. `model.questions`
    /// already filters replied ids, so this is nil the moment the user answers
    /// (optimistic) and stays nil once the Mac resolves/expires it.
    private var liveCard: MobileQuestionCard? {
        guard !promptId.isEmpty else { return nil }
        return model.questions.first { $0.resolvedId == promptId }
    }

    var body: some View {
        if let card = liveCard {
            QuestionRow(model: model, card: card)
        } else {
            AgentQuestionSettledCard(
                question: question,
                // The registry drops a question the moment this device replies,
                // BEFORE the Mac projects the answer back. Without this flag the
                // card would spend that window claiming the question was skipped.
                awaitingProjection: model.hasPendingLocalQuestionReply(promptId))
        }
    }
}

/// The settled twin — what the question leaves behind once answered or skipped.
///
/// Read-only by construction: no bindings, no model, nothing that could re-answer
/// a parked tool that has already resolved.
struct AgentQuestionSettledCard: View {
    let question: RemoteThreadSnapshot.Row.AgentQuestion
    /// Answered on this device, projection not back yet.
    var awaitingProjection: Bool = false

    private var answered: Bool { question.isAnswered }
    private var options: [String] { question.options ?? [] }

    /// A typed answer matches no option, so it gets its own line rather than
    /// silently ticking nothing.
    private var customAnswer: String? {
        guard answered, question.isCustomAnswer == true else { return nil }
        return question.answer
    }

    private var chosenOption: String? {
        guard answered, question.isCustomAnswer != true else { return nil }
        return question.answer
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Asked")
                .font(Font.caption2)
                .foregroundStyle(TWTheme.textTertiary)
                .textCase(.uppercase)

            Text(question.question ?? "Question")
                .font(Font.callout)
                .foregroundStyle(TWTheme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            if let context = question.context, !context.isEmpty {
                Text(context)
                    .font(Font.caption)
                    .foregroundStyle(TWTheme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !options.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(options, id: \.self) { option in
                        optionRow(option, isChosen: option == chosenOption)
                    }
                }
            }

            if let customAnswer {
                VStack(alignment: .leading, spacing: 2) {
                    Text("You answered")
                        .font(Font.caption2)
                        .foregroundStyle(TWTheme.textTertiary)
                    Text(customAnswer)
                        .font(Font.caption.weight(.semibold))
                        .foregroundStyle(TWTheme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Text(outcomeLabel)
                .font(Font.caption2)
                .foregroundStyle(
                    answered || awaitingProjection ? TWTheme.textTertiary : TWTheme.textMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(TWTheme.surface2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(TWTheme.border)
        )
    }

    /// Three states, not two. "Skipped" is only claimed once we know no answer
    /// is in flight — otherwise it would libel an answer the user just sent.
    private var outcomeLabel: String {
        if answered { return "Answered" }
        if awaitingProjection { return "Sending…" }
        return "Skipped — no answer sent"
    }

    @ViewBuilder
    private func optionRow(_ option: String, isChosen: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(option)
                // Unchosen options stay legible but clearly secondary — they are
                // the shape of the decision, not the decision.
                .font(isChosen ? Font.caption.weight(.semibold) : Font.caption)
                .foregroundStyle(isChosen ? TWTheme.textPrimary : TWTheme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            if isChosen {
                Image(systemName: "checkmark")
                    .font(Font.caption2)
                    .foregroundStyle(TWTheme.diffStatAdd)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Spoken as one phrase rather than "option, checkmark".
        .accessibilityElement(children: .combine)
        .accessibilityLabel(isChosen ? "\(option), chosen" : option)
    }
}
