import SwiftUI

/// Desktop `ParticipantStatusIcon` twin — monoline SF Symbols tinted by the
/// caller (roster chips / Task-complete Participants work cell). Status words
/// match `EnsembleParticipantStatus` plus synthetic `speaking` / `running`.
struct TWParticipantStatusIcon: View {
    let status: String

    private var key: String {
        status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var systemName: String {
        switch key {
        case "speaking", "running":
            return "megaphone.fill"
        case "yielded":
            return "arrow.uturn.right"
        case "answered", "completed":
            return "checkmark"
        case "failed":
            return "exclamationmark.triangle"
        case "skipped":
            return "forward.fill"
        case "cancelled":
            return "nosign"
        case "unreachable":
            return "link.badge.plus"
        case "sleeping":
            return "alarm"
        default:
            return "zzz"
        }
    }

    private var tint: Color {
        switch key {
        case "speaking", "running":
            return TWTheme.chroma1
        case "yielded":
            return Color(red: 0.84, green: 0.64, blue: 0.23)
        case "answered", "completed":
            return TWTheme.statusSuccess
        case "failed", "unreachable":
            return TWTheme.statusFailed
        case "cancelled", "skipped", "idle", "sleeping":
            return TWTheme.textMuted
        default:
            return TWTheme.textSecondary
        }
    }

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(tint)
            .accessibilityLabel(status.isEmpty ? "Unknown" : status.capitalized)
    }
}
