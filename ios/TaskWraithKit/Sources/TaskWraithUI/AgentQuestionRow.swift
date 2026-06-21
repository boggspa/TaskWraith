// Inline ask_user_question card — the iOS mirror of the desktop AgentQuestionCard.
// The Mac projects the question as `row.agentQuestion` (RemoteThreadProjection
// buildAgentQuestion); ThreadRowView branches here so the question renders INLINE
// in the transcript (anchored to its asking message) instead of only in the top
// attention banner.
//
// The answer round-trip is UNCHANGED. While the question is still open it lives
// in `model.questions` (the parked-tool registry envelope), so we render the
// existing self-contained `QuestionRow` against that live card — model.answer /
// rejectQuestion resolve the same parked tool the banner did. Once answered /
// dismissed / expired the registry drops it from `model.questions` (which already
// excludes optimistically-replied ids), so we collapse to a muted "resolved"
// line; the user's answer shows as a normal user bubble below, matching desktop.

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
            resolvedView
        }
    }

    private var resolvedView: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "checkmark.circle")
                .font(.caption)
                .foregroundStyle(TWTheme.textTertiary)
            Text(question.question ?? "Question")
                .font(.caption)
                .foregroundStyle(TWTheme.textTertiary)
                .lineLimit(2)
        }
        .padding(.vertical, 2)
    }
}
