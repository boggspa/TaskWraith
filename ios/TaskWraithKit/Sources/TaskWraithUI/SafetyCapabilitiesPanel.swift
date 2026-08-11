// Safety & Capabilities inspector tab — the read-only phone twin of the
// desktop Inspector's Safety and Capabilities tabs, assembled from state the
// Mac ALREADY projects on the task card. The asymmetry this closes: the
// phone can grant acceptForWorkspace and set postures, but until now could
// not SEE what posture, capabilities, and standing grants were in force.
// Read-only by construction — no bindings, no actions, nothing that could
// mutate a posture from a surface meant for inspection.

import SwiftUI
import TaskWraithKit

struct SafetyCapabilitiesPanel: View {
    let card: RemoteTaskCard

    private var presetId: String? { card.permissionPresetId ?? card.approvalMode }
    private var tier: TWPermissionTier { TWPermissionTiers.tier(presetId) }

    /// The desktop SafetyTab's provider sandbox derivation, ported for the
    /// providers where it is a plain mapping; everything else states the
    /// honest generic.
    private var sandboxLine: String {
        if card.provider == "codex" {
            return (card.approvalMode == "plan" || card.workflowMode == "plan")
                ? "read-only" : "workspace-write"
        }
        return "Provider-managed"
    }

    private var capabilityRows: [(label: String, granted: Bool?)] {
        let caps = card.capabilities
        return [
            ("Approve requests", caps?.approve),
            ("Answer questions", caps?.answer),
            ("Start turns", caps?.startTurn),
            ("Steer runs", caps?.steer),
            ("Cancel runs", caps?.cancel),
            ("Review diffs", caps?.diffReview),
            ("Browse files", caps?.fileBrowse),
            ("Read files", caps?.fileRead),
            ("Write files", caps?.fileWrite),
            ("Publish externally", caps?.externalPublish),
            ("Delete messages", caps?.deleteMessage),
        ]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            section("Posture") {
                row("Permission tier") {
                    HStack(spacing: 4) {
                        Image(systemName: tier.systemImage)
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(tier.tint ?? TWTheme.textSecondary)
                        Text(TWPermissionTiers.label(presetId))
                            .foregroundStyle(tier.tint ?? TWTheme.textPrimary)
                    }
                }
                row("Workflow") {
                    Text(card.workflowMode == "plan" ? "Plan (approval-gated)" : "Normal")
                }
                row("Sandbox") { Text(sandboxLine) }
                row("Trusted session") {
                    Text(card.trustedSessionEnabled == true ? "On" : "Off")
                        .foregroundStyle(
                            card.trustedSessionEnabled == true
                                ? TWTheme.statusAttention : TWTheme.textSecondary)
                }
                row("External grants") {
                    Text(grantsLabel)
                        .foregroundStyle(
                            (card.externalGrantsCount ?? 0) > 0
                                ? TWTheme.statusAttention : TWTheme.textSecondary)
                }
            }

            section("This device can") {
                ForEach(capabilityRows, id: \.label) { entry in
                    HStack(spacing: 6) {
                        Image(
                            systemName: entry.granted == true
                                ? "checkmark.circle.fill"
                                : entry.granted == false ? "xmark.circle" : "questionmark.circle"
                        )
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(
                            entry.granted == true
                                ? TWTheme.statusSuccess
                                : entry.granted == false ? TWTheme.textMuted : TWTheme.textTertiary)
                        Text(entry.label)
                            .font(.caption)
                            .foregroundStyle(
                                entry.granted == false ? TWTheme.textMuted : TWTheme.textPrimary)
                        Spacer(minLength: 0)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(
                        "\(entry.label): \(entry.granted == true ? "allowed" : entry.granted == false ? "not allowed" : "unknown")"
                    )
                }
            }

            Text(
                "Read-only. Postures change from the composer picker; workspace access changes on the Mac."
            )
            .font(.caption2)
            .foregroundStyle(TWTheme.textMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var grantsLabel: String {
        let count = card.externalGrantsCount ?? 0
        if count == 0 { return card.status == "running" ? "None" : "None (no active run)" }
        return "\(count) active-run grant\(count == 1 ? "" : "s")"
    }

    @ViewBuilder
    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(TWTheme.textSecondary)
            VStack(alignment: .leading, spacing: 6) {
                content()
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TWTheme.border))
        }
    }

    @ViewBuilder
    private func row(_ label: String, @ViewBuilder value: () -> some View) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.caption)
                .foregroundStyle(TWTheme.textSecondary)
            Spacer(minLength: 8)
            value()
                .font(.caption.weight(.medium))
        }
    }
}
