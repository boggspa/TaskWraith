// Codex-style proposed-plan card, rendered INLINE in the transcript — the iOS
// mirror of the desktop ProposedPlanCard. The Mac projects the plan as a
// structured `row.proposedPlan` field (RemoteThreadProjection.buildProposedPlan),
// and ThreadRowView branches to this card when the field is present.
//
// Slice 2b ships the READ-ONLY surface: a collapsible "Plan" card with a status
// pill (Pending / Approved / Dismissed) and the (bounded) plan body. The
// approve / respond / dismiss action row + round-trip lands in slice 2c — the
// `model` / `threadId` / `rowId` parameters are threaded now so the call site in
// ThreadRowView stays stable when the actions are wired.

import Foundation
import SwiftUI
import TaskWraithKit

struct ProposedPlanRow: View {
    @ObservedObject var model: RemoteSessionModel
    let threadId: String
    let rowId: String
    let plan: RemoteThreadSnapshot.Row.ProposedPlan

    @State private var expanded: Bool
    @State private var feedback: String = ""

    init(
        model: RemoteSessionModel,
        threadId: String,
        rowId: String,
        plan: RemoteThreadSnapshot.Row.ProposedPlan
    ) {
        self.model = model
        self.threadId = threadId
        self.rowId = rowId
        self.plan = plan
        // Pending plans open for review; a decided plan collapses to its outcome
        // (matching the desktop ProposedPlanCard).
        _expanded = State(initialValue: (plan.status ?? "pending") == "pending")
    }

    private var status: String { plan.status ?? "pending" }
    /// Card hue tracks the outcome so a decided plan stops looking like it still
    /// wants attention: amber while pending, green once approved, muted when
    /// dismissed. Drives the border, gradient, header icon, and the Pending pill.
    private var accent: Color {
        switch status {
        case "approved": return TWTheme.statusSuccess
        case "dismissed": return TWTheme.textTertiary
        default: return TWTheme.statusAttention
        }
    }
    private var title: String {
        let value = plan.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? "Proposed plan" : value
    }
    private var displayBody: String {
        let value = plan.bodyPreview?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? "No plan details." : value
    }
    private var artifactPath: String? {
        let value = plan.artifactPath?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? nil : value
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            header
            if expanded {
                MarkdownLite(displayBody, baseColor: TWTheme.textPrimary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let artifactPath {
                    HStack(spacing: 6) {
                        Image(systemName: "doc.text")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(accent)
                        Text(artifactPath)
                            .font(.caption2)
                            .foregroundStyle(TWTheme.textSecondary)
                            .lineLimit(2)
                            .textSelection(.enabled)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(TWTheme.surface2.opacity(0.72), in: Capsule())
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Plan file \(artifactPath)")
                }
                if plan.bodyTruncated == true {
                    Text("Plan truncated — open on desktop to read it in full.")
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textTertiary)
                }
                // Actions only while the plan is awaiting a decision; a decided
                // plan (re-projected approved/dismissed) shows just its pill.
                if status == "pending" {
                    actionRow
                }
            }
        }
        .padding(10)
        .background(
            LinearGradient(
                colors: [accent.opacity(0.12), TWTheme.surface1.opacity(0.76)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 12)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(accent.opacity(0.5), lineWidth: 1.1)
        )
        .onChange(of: plan.status) { _, newStatus in
            // The row's SwiftUI identity is message.id (stable across
            // re-projection), so @State init runs ONCE — it never re-evaluates
            // when a decision flips status pending→approved/dismissed. Re-derive
            // the collapse here so a decided card collapses to its outcome (the
            // pill already updates; this makes the body follow). Fires only on a
            // status transition, so a user's manual toggle while pending is kept.
            withAnimation(.easeInOut(duration: 0.16)) {
                expanded = (newStatus ?? "pending") == "pending"
            }
        }
    }

    private var header: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.16)) { expanded.toggle() }
        } label: {
            HStack(alignment: .center, spacing: 6) {
                Image(systemName: "list.bullet.rectangle")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(accent)
                Text("Plan")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TWTheme.textTertiary)
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 6)
                statusPill
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Plan, \(title)")
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
        .accessibilityHint("Double tap to expand or collapse.")
        .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder private var statusPill: some View {
        switch status {
        case "approved":
            pill("Approved", TWTheme.statusSuccess)
        case "dismissed":
            pill("Dismissed", TWTheme.textTertiary)
        default:
            pill("Pending", accent)
        }
    }

    private func pill(_ text: String, _ color: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.bold))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.14), in: Capsule())
    }

    /// True once the user has tapped Approve/Respond/Dismiss locally — the
    /// optimistic suppression keyed on the plan's messageId (rowId). Disables the
    /// row so it can't double-fire before the Mac's status re-projection lands.
    private var decided: Bool { model.proposedPlanIsReplied(rowId) }

    private var actionRow: some View {
        VStack(spacing: 7) {
            HStack(spacing: 7) {
                Button("Approve") {
                    model.proposedPlanApprove(threadId: threadId, messageId: rowId)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(accent)
                .disabled(decided)
                Spacer(minLength: 0)
                Button("Dismiss", role: .destructive) {
                    model.proposedPlanDismiss(threadId: threadId, messageId: rowId)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(decided)
            }
            HStack(spacing: 7) {
                TextField("Respond with feedback…", text: $feedback)
                    .font(.footnote)
                    .foregroundStyle(TWTheme.textPrimary)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .background(TWTheme.surface2, in: Capsule())
                    .disabled(decided)
                    .accessibilityLabel("Plan feedback")
                Button {
                    model.proposedPlanRespond(threadId: threadId, messageId: rowId, feedback: feedback)
                    feedback = ""
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title3)
                        .foregroundStyle(
                            feedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                ? TWTheme.textMuted : TWTheme.chroma1)
                }
                .buttonStyle(.plain)
                .disabled(decided || feedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Send feedback on plan")
            }
        }
    }
}
