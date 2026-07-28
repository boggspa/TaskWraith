// The iOS context-donut popover: tapping the composer ContextDonut opens this
// (via .popover + .presentationCompactAdaptation, the GoalRail/PlanRail pattern)
// to show a context meter + model/amount labels. Solo chats show one row for the
// active model; ensemble chats stack one row per participant (each its own model
// + window). The numbers are the HONEST current-context proxy (latest turn's
// input+output ÷ window — solo computed on-device, per-participant projected from
// the Mac as roster.contextTokens), so it's labeled estimated. Mirrors the
// desktop ContextMeterPopover.
import SwiftUI
import TaskWraithKit

/// One row in the context-meter popover (solo, or one ensemble participant).
struct ContextMeterRowVM: Identifiable {
    let id: String
    /// Role (ensemble) or provider label (solo).
    let primary: String
    /// Secondary muted line — model (solo) or "Provider · model" (ensemble).
    let detail: String
    let provider: String
    let model: String?
    let usedTokens: Int
    let windowTokens: Int
    var percent: Double {
        windowTokens > 0 ? min(100, max(0, Double(usedTokens) / Double(windowTokens) * 100)) : 0
    }
}

/// "222k" / "1.0M" — matches the desktop `formatContextTokens`.
func twContextTokenLabel(_ value: Int) -> String {
    if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
    if value >= 1_000 { return "\(value / 1_000)k" }
    return "\(value)"
}

struct ContextMeterPopoverBody: View {
    let rows: [ContextMeterRowVM]
    let ensemble: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(ensemble ? "Context · per participant" : "Context usage")
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
            if rows.isEmpty {
                Text("No context yet")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            } else {
                // Cap + scroll so a many-participant ensemble doesn't clip off the
                // top (PlanRail parity). Short content stays short.
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(rows) { ContextMeterRowView(row: $0) }
                    }
                }
                .frame(maxHeight: 320)
            }
            Text("Estimated from the latest turn")
                .font(.system(size: 10))
                .italic()
                .foregroundStyle(.tertiary)
        }
    }
}

private struct ContextMeterRowView: View {
    let row: ContextMeterRowVM

    var body: some View {
        let accent = TWTheme.providerAccent(
            row.provider, modelId: row.model, modelLabel: row.model)
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Circle().fill(accent).frame(width: 7, height: 7)
                Text(row.primary)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                    .layoutPriority(1)
                if !row.detail.isEmpty {
                    Text(row.detail)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 8)
                NumericTickText(
                    "\(Int(row.percent.rounded()))%",
                    value: row.percent,
                    font: .caption.weight(.semibold).monospacedDigit(),
                    color: Color.secondary)
                    .fixedSize(horizontal: true, vertical: false)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.14))
                    Capsule()
                        .fill(accent)
                        .frame(width: max(2, geo.size.width * row.percent / 100))
                }
            }
            .frame(height: 5)
            Text("\(twContextTokenLabel(row.usedTokens)) / \(twContextTokenLabel(row.windowTokens)) context")
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(.tertiary)
        }
    }
}
