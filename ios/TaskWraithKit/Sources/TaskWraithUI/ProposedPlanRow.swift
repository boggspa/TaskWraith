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

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            header
            if expanded {
                MarkdownLite(displayBody, baseColor: TWTheme.textPrimary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if plan.bodyTruncated == true {
                    Text("Plan truncated — open on desktop to read it in full.")
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textTertiary)
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
}
