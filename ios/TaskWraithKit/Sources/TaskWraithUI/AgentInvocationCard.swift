import SwiftUI
import TaskWraithKit

/// Extracted Agent Invocation card — iOS mirror of desktop
/// `SubThreadDelegationCard`. `ThreadRowView` supplies the structured wire
/// metadata, live child status, and an existing-child-only navigation intent.
struct AgentInvocationCard: View {
    let input: AgentInvocationCardInput
    /// Resolved open intent for the existing child. Missing/stale ids disable
    /// the action rather than creating a new side chat.
    let navigation: ExistingChildNavigationIntent
    var onOpenExistingChild: ((String, ExistingChildOpenDestination) -> Void)?

    init(
        input: AgentInvocationCardInput,
        navigation: ExistingChildNavigationIntent = .unavailable(reason: "not wired"),
        onOpenExistingChild: ((String, ExistingChildOpenDestination) -> Void)? = nil
    ) {
        self.input = input
        self.navigation = navigation
        self.onOpenExistingChild = onOpenExistingChild
    }

    private var accent: Color {
        if let hex = input.agentAccent, let color = Color(hexString: hex) {
            return color
        }
        return TWTheme.providerAccent(input.targetProvider)
    }

    private var canOpen: Bool {
        navigation.isAvailable && onOpenExistingChild != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            header
            bodyBlock
            if canOpen, case .openExistingChild(let id, let destination) = navigation {
                Button {
                    onOpenExistingChild?(id, destination)
                } label: {
                    Text(navigation.actionLabel)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TWTheme.chroma1)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(TWTheme.surface1, in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(navigation.accessibilityLabel)
            }
            if input.showsResultReturnedFooter {
                footerRow(symbol: "arrow.turn.up.left", text: "Result returned to this thread")
            }
            if let dispatchError = input.dispatchErrorMessage {
                footerRow(symbol: "exclamationmark.triangle", text: dispatchError)
            }
        }
        .padding(10)
        .background(
            LinearGradient(
                colors: [accent.opacity(0.13), TWTheme.surface1.opacity(0.76)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 12)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(accent.opacity(0.54), lineWidth: 1.2)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilitySummary)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Agent Invocation")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TWTheme.textTertiary)
                    .textCase(.uppercase)
                if let agentName = input.agentName {
                    Text(agentName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(accent)
                        .lineLimit(1)
                }
                HStack(spacing: 4) {
                    providerChip(input.parentProvider)
                    Image(systemName: "arrow.right")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(TWTheme.textTertiary)
                    providerChip(input.targetProvider)
                }
            }
            Spacer(minLength: 8)
            statusPill
        }
    }

    private var bodyBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(input.title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(TWTheme.textPrimary)
                .lineLimit(2)
            if let prompt = input.promptPreview {
                Text(prompt)
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textMuted)
                    .lineLimit(3)
            }
            Text(routeNoteText)
                .font(.caption2)
                .foregroundStyle(TWTheme.textTertiary)
                .lineLimit(2)
        }
    }

    private var routeNoteText: String {
        if canOpen {
            return "\(input.routeNote) · opens existing child"
        }
        return input.routeNote
    }

    private var statusPill: some View {
        HStack(spacing: 4) {
            Text(input.status.glyph)
                .font(.caption2.weight(.bold))
            Text(input.status.label)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(statusForeground)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(statusForeground.opacity(0.14), in: Capsule())
        .accessibilityLabel("Status \(input.status.label)")
    }

    private var statusForeground: Color {
        switch input.status {
        case .running: return TWTheme.statusRunning
        case .completed, .returned: return TWTheme.statusSuccess
        case .failed: return TWTheme.statusFailed
        case .cancelled: return TWTheme.textTertiary
        case .created, .unknown: return TWTheme.statusAttention
        }
    }

    private func providerChip(_ provider: String?) -> some View {
        let label = TWTheme.providerLabel(provider)
        let color = TWTheme.providerAccent(provider)
        return Text(label)
            .font(.caption2.weight(.bold))
            .foregroundStyle(color)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.14), in: Capsule())
    }

    private func footerRow(symbol: String, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: symbol)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(TWTheme.textTertiary)
            Text(text)
                .font(.caption2)
                .foregroundStyle(TWTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var accessibilitySummary: String {
        var parts = [
            "Agent Invocation",
            input.title,
            "status \(input.status.label)",
            input.routeNote
        ]
        if let agentName = input.agentName { parts.insert(agentName, at: 1) }
        return parts.joined(separator: ", ")
    }
}

private extension Color {
    /// Best-effort parse of `#RRGGBB` / `RRGGBB` agent accents from the Mac.
    init?(hexString: String) {
        var raw = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.hasPrefix("#") { raw.removeFirst() }
        guard raw.count == 6, let value = UInt32(raw, radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}
