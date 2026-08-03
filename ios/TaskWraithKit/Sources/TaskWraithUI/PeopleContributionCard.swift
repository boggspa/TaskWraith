// Extracted SwiftUI card for Human People contributions.
// Wire later from ThreadRowView once CodexBoss lands a structured remote field;
// this file must stay free of RemoteSessionModel / Models.swift dependencies
// beyond TWTheme + MarkdownLite already used by peer-adjacent cards.

import SwiftUI

struct PeopleContributionCard: View {
    let model: PeopleContributionCardModel
    /// Host gesture only — inserts a composer draft. Never auto-sends.
    /// Integrator supplies Mac-side framing (`wrapExternalContribution`);
    /// this view only surfaces the affordance and message id.
    var onInsertAsDraft: ((String) -> Void)?

    private var accent: Color { TWTheme.statusAttention }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            Text(model.trustCaption)
                .font(.caption2)
                .foregroundStyle(TWTheme.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            bodyText
            if model.truncated {
                Text("Contribution truncated — open on desktop to read it in full.")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
            }
            if model.showsInsertAsDraft {
                insertRow
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            LinearGradient(
                colors: [accent.opacity(0.10), TWTheme.surface1.opacity(0.78)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 12)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(accent.opacity(0.45), lineWidth: 1.1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(model.accessibilityLabel)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 6) {
            Image(systemName: "person.crop.circle.badge.exclamationmark")
                .font(.caption.weight(.bold))
                .foregroundStyle(accent)
                .accessibilityHidden(true)
            Text(model.displayName)
                .font(.caption.weight(.semibold))
                .foregroundStyle(TWTheme.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
            ForEach(Array(model.badges.enumerated()), id: \.offset) { _, badge in
                badgePill(badge)
            }
            Spacer(minLength: 0)
        }
        .accessibilityAddTraits(.isHeader)
    }

    private func badgePill(_ badge: PeopleContributionBadge) -> some View {
        Text(badge.label)
            .font(.caption2.weight(.bold))
            .foregroundStyle(accent)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(accent.opacity(0.14), in: Capsule())
            .accessibilityLabel(badge.label)
            .accessibilityHint(badge.accessibilityHint)
    }

    /// Desktop People rows render markdown; keep MarkdownLite here for parity.
    /// Attribution chrome (External / never System) is the trust boundary —
    /// Peer plain-text containment is a separate card.
    private var bodyText: some View {
        Group {
            if model.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("No contribution text.")
                    .font(.body)
                    .foregroundStyle(TWTheme.textMuted)
            } else {
                MarkdownLite(model.body, baseColor: TWTheme.textPrimary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var insertRow: some View {
        HStack(spacing: 8) {
            if let onInsertAsDraft {
                Button {
                    onInsertAsDraft(model.messageId)
                } label: {
                    Text(model.insertAsDraftLabel)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TWTheme.chroma1)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(TWTheme.surface1, in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(model.insertAsDraftLabel)
                .accessibilityHint(model.insertAsDraftHint)
            }
            if let status = model.insertedAsDraftStatus {
                Text(status)
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textSecondary)
            }
            Spacer(minLength: 0)
        }
    }
}

#if DEBUG
#Preview("Queued action request") {
    PeopleContributionCard(
        model: peopleContributionCardModel(
            PeopleContributionCardInput(
                messageId: "c1",
                collaboratorDisplayName: "Alex",
                body: "Please run the failing tests and paste the first error.",
                delivery: .queuedComment,
                intent: .requestHostAction
            )
        ),
        onInsertAsDraft: { _ in }
    )
    .padding()
    .background(TWTheme.appBg)
}

#Preview("Delivered out of position") {
    PeopleContributionCard(
        model: peopleContributionCardModel(
            PeopleContributionCardInput(
                messageId: "d1",
                collaboratorDisplayName: "Sam",
                body: "Shipping the patch tonight.",
                delivery: .deliveredExternalSeat,
                outOfPosition: true
            )
        )
    )
    .padding()
    .background(TWTheme.appBg)
}
#endif
