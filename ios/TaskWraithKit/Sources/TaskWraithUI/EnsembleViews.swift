// SwiftUI surface for the TaskWraith companion.
//
// Design direction (see ios/DESIGN.md): borrow the *format* of the Claude /
// Codex iOS apps — workspaces-as-projects home, thread view with collapsed
// history + tool chips, pill composer — but skinned entirely in TaskWraith's
// own theme tokens (TWTheme mirrors the desktop theme.css). iPhone focuses on
// solid thread management; iPad gets the sidebar (NavigationSplitView) where
// advanced affordances will live. Pure SwiftUI so `swift build` compile-checks
// on macOS; QR camera scanning is the one `#if os(iOS)` extra.

import SwiftUI
import TaskWraithKit

#if canImport(UIKit)
    import PhotosUI
    import UIKit
#endif

struct EnsembleRosterStrip: View {
    let state: RemoteEnsembleState
    let participants: [RemoteEnsembleState.Participant]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(
                    participants.sorted { ($0.order ?? 0) < ($1.order ?? 0) }
                ) { participant in
                    chip(participant)
                }
            }
            .padding(.horizontal, 12)
        }
        .padding(.vertical, 2)
    }

    private func modelForParticipant(_ participant: RemoteEnsembleState.Participant) -> String? {
        state.roster?.first(where: { $0.id == participant.participantId })?.model
    }

    @ViewBuilder
    private func chip(_ participant: RemoteEnsembleState.Participant) -> some View {
        let retired = TWTheme.isRetiredProvider(participant.provider)
        let modelId = modelForParticipant(participant)
        let accent =
            retired
            ? TWTheme.textMuted
            : TWTheme.providerAccent(participant.provider, modelId: modelId)
        let isActive = !retired && participant.participantId == state.activeParticipantId
        HStack(spacing: 4) {
            if retired {
                Image(systemName: "lock.fill").font(.system(size: 7))
            } else {
                Circle()
                    .fill(statusColor(participant.status, accent: accent))
                    .frame(width: 5, height: 5)
            }
            Text(
                participant.role?.isEmpty == false
                    ? participant.role!
                    : TWTheme.providerLabel(
                        participant.provider, modelId: modelId, modelLabel: modelId)
            )
            .font(.caption2.weight(isActive ? .bold : .medium))
            .lineLimit(1)
            .strikethrough(retired, color: TWTheme.textMuted)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(accent.opacity(isActive ? 0.22 : 0.10), in: Capsule())
        .overlay(Capsule().strokeBorder(accent.opacity(isActive ? 0.6 : 0.25)))
        .foregroundStyle(isActive ? accent : TWTheme.textSecondary)
        .opacity(retired ? 0.5 : 1)
    }

    private func statusColor(_ status: String?, accent: Color) -> Color {
        switch status {
        case "running", "active": return accent
        case "completed", "done": return TWTheme.statusSuccess
        case "failed", "error": return TWTheme.statusFailed
        case "skipped": return TWTheme.textMuted
        default: return TWTheme.textTertiary
        }
    }
}

/// Empty-thread welcome — mirrors the desktop welcome greeting block.
