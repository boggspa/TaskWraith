// Extracted multi-select participant / System filter surface.
//
// Pure presentation over `TranscriptParticipantFilter`; ThreadDetailView owns
// the session-only selection and applies it to the loaded transcript.

import SwiftUI

public struct TranscriptParticipantFilterRail: View {
    public var items: [TranscriptParticipantFilterItem]
    public var activeFilterKeys: Set<String>
    public var onToggle: (String) -> Void

    public init(
        items: [TranscriptParticipantFilterItem],
        activeFilterKeys: Set<String>,
        onToggle: @escaping (String) -> Void
    ) {
        self.items = items
        self.activeFilterKeys = activeFilterKeys
        self.onToggle = onToggle
    }

    public var body: some View {
        if items.isEmpty {
            EmptyView()
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(items) { item in
                        filterChip(item)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Transcript participant filter")
            .accessibilityHint(
                activeFilterKeys.isEmpty
                    ? "No filter active. Showing all messages."
                    : "Filtering to \(activeFilterKeys.count) selected sources."
            )
        }
    }

    @ViewBuilder
    private func filterChip(_ item: TranscriptParticipantFilterItem) -> some View {
        let active = activeFilterKeys.contains(item.key)
        Button {
            onToggle(item.key)
        } label: {
            HStack(spacing: 4) {
                if item.kind == .system {
                    Image(systemName: "gearshape.fill")
                        .font(.caption2)
                } else if let ordinal = item.ordinal {
                    Text("\(ordinal)")
                        .font(.caption2.monospacedDigit().weight(.semibold))
                }
                Text(chipLabel(item))
                    .font(.caption.weight(active ? .semibold : .regular))
                    .lineLimit(1)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                Capsule(style: .continuous)
                    .fill(active ? Color.accentColor.opacity(0.22) : Color.secondary.opacity(0.12))
            )
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(
                        active ? Color.accentColor.opacity(0.55) : Color.secondary.opacity(0.18),
                        lineWidth: 1
                    )
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(item.title)
        .accessibilityAddTraits(active ? [.isSelected] : [])
        .accessibilityHint(
            active
                ? "Selected. Double tap to remove from filter."
                : "Double tap to include in filter. Empty selection shows all."
        )
    }

    private func chipLabel(_ item: TranscriptParticipantFilterItem) -> String {
        switch item.kind {
        case .system:
            return "System"
        case .participant:
            return item.role
        }
    }
}
