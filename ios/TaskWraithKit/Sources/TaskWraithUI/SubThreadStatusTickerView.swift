import SwiftUI
import TaskWraithKit

/// Ambient live strip above the parent transcript — iOS mirror of desktop
/// `SubThreadStatusTicker`. Renders only while ≥1 **direct** sub-thread is
/// live; clicks open the existing child (never create a new side chat).
struct SubThreadStatusTickerView: View {
    let model: SubThreadTickerModel
    var onOpenExistingChild: ((String) -> Void)?

    var body: some View {
        if model.isEmpty {
            EmptyView()
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    parentChip
                    Text("·")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(TWTheme.textTertiary)
                        .accessibilityHidden(true)
                    ForEach(model.items) { item in
                        childChip(item)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
            }
            .background(TWTheme.surface1.opacity(0.92))
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(TWTheme.surface3.opacity(0.7))
                    .frame(height: 1)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(model.accessibilityLabel)
        }
    }

    private var parentChip: some View {
        HStack(spacing: 6) {
            providerBadge(model.parentProvider)
            Text("orchestrating")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(TWTheme.textSecondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(model.parentProviderLabel) orchestrating")
    }

    private func childChip(_ item: SubThreadTickerItem) -> some View {
        let isClickable = onOpenExistingChild != nil
        return Button {
            onOpenExistingChild?(item.id)
        } label: {
            HStack(spacing: 6) {
                Circle()
                    .fill(TWTheme.providerAccent(item.provider))
                    .frame(width: 6, height: 6)
                    .accessibilityHidden(true)
                providerBadge(item.provider)
                Text("sub-thread active")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TWTheme.textSecondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(TWTheme.surface2.opacity(0.8), in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!isClickable)
        .accessibilityLabel(item.accessibilityLabel)
        .accessibilityHint(isClickable ? "Opens the existing sub-thread \(item.title)" : "")
    }

    private func providerBadge(_ provider: String?) -> some View {
        let label = TWTheme.providerLabel(provider)
        let color = TWTheme.providerAccent(provider)
        return Text(label)
            .font(.caption2.weight(.bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color, in: Capsule())
    }
}
