import SwiftUI
import TaskWraithKit

/// Displays official maximum context window sizes per model, grouped by
/// provider. This is a STATIC reference table — no live quota data, no
/// percent bars, no reset times. Intentionally visually distinct from
/// UsagePanel (which shows live quota usage) so users cannot confuse
/// context-length capacity with quota consumption.
struct ContextLengthsView: View {
    let includeOllama: Bool
    let excludeProviders: [String]

    init(includeOllama: Bool = true, excludeProviders: [String] = []) {
        self.includeOllama = includeOllama
        self.excludeProviders = excludeProviders
    }

    var body: some View {
        let groups = ModelContextLengths.buildGroups(
            includeOllama: includeOllama,
            excludeProviders: excludeProviders
        )
        VStack(alignment: .leading, spacing: 10) {
            ForEach(groups) { group in
                providerCard(group)
            }
        }
    }

    @ViewBuilder
    private func providerCard(_ group: ModelContextLengthGroup) -> some View {
        let accent = TWTheme.providerAccent(group.provider)
        VStack(alignment: .leading, spacing: 8) {
            // Provider header — mirrors UsagePanel.providerSection tile anatomy
            HStack(spacing: 7) {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(accent.opacity(0.18))
                    .frame(width: 20, height: 20)
                    .overlay(
                        Image(systemName: "ruler")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(accent)
                    )
                Text(TWTheme.providerLabel(group.provider))
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TWTheme.textPrimary)
                Spacer()
                Text("\(group.models.count) model\(group.models.count == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
            }
            // Per-model rows: label on left, formatted context window on right
            ForEach(group.models, id: \.modelId) { row in
                HStack(alignment: .firstTextBaseline) {
                    Text(row.label)
                        .font(.caption)
                        .foregroundStyle(TWTheme.textPrimary)
                    Spacer()
                    Text(row.formatted)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(TWTheme.textSecondary)
                }
            }
        }
        .padding(10)
        .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TWTheme.border))
    }
}
