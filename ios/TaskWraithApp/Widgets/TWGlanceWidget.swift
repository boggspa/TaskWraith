// Home-screen glance widget — the running/last-run status board the widget
// bundle's deferral comment promised. Reads ONLY the app-written
// TWWidgetSnapshot from the App Group; links TaskWraithKit only (the NSE
// rule), so every colour arrives as an app-resolved hex and there is no
// theme catalogue on this side of the process boundary.

import SwiftUI
import TaskWraithKit
import WidgetKit

struct TWGlanceEntry: TimelineEntry {
    let date: Date
    let snapshot: TWWidgetSnapshot?
}

struct TWGlanceProvider: TimelineProvider {
    func placeholder(in context: Context) -> TWGlanceEntry {
        TWGlanceEntry(date: Date(), snapshot: placeholderSnapshot)
    }

    func getSnapshot(in context: Context, completion: @escaping (TWGlanceEntry) -> Void) {
        completion(
            TWGlanceEntry(
                date: Date(),
                snapshot: context.isPreview
                    ? placeholderSnapshot
                    : TWWidgetSnapshot.load(suiteName: TWPushKeyAccess.appGroup)))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TWGlanceEntry>) -> Void) {
        let entry = TWGlanceEntry(
            date: Date(), snapshot: TWWidgetSnapshot.load(suiteName: TWPushKeyAccess.appGroup))
        // The app reloads the timeline on every snapshot write; this refresh
        // only exists so staleness dimming appears without an app launch.
        completion(
            Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60))))
    }

    private var placeholderSnapshot: TWWidgetSnapshot {
        TWWidgetSnapshot(
            generatedAt: Int64(Date().timeIntervalSince1970 * 1000),
            hostName: "Mac",
            rows: [
                TWWidgetSnapshot.Row(
                    threadId: "a", title: "Refactor the auth flow", status: "running",
                    providerLabel: "Ensemble", tintHex: 0x5A8CFF,
                    updatedAt: Int64(Date().timeIntervalSince1970 * 1000)),
                TWWidgetSnapshot.Row(
                    threadId: "b", title: "Ship the release notes", status: "completed",
                    providerLabel: "Codex", tintHex: 0x2DB777,
                    updatedAt: Int64(Date().timeIntervalSince1970 * 1000) - 120000),
                TWWidgetSnapshot.Row(
                    threadId: "c", title: "Update widget UI", status: "failed",
                    providerLabel: "Claude", tintHex: 0xFF3B30,
                    updatedAt: Int64(Date().timeIntervalSince1970 * 1000) - 7200000)
            ])
    }
}

private struct TWGlanceView: View {
    let entry: TWGlanceEntry
    @Environment(\.widgetFamily) private var family

    private var snapshot: TWWidgetSnapshot? { entry.snapshot }
    private var stale: Bool { snapshot?.isStale(now: entry.date) ?? false }
    private var visibleRows: [TWWidgetSnapshot.Row] {
        let limit = family == .systemSmall ? 2 : 3
        return Array((snapshot?.rows ?? []).prefix(limit))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                Text(snapshot?.hostName ?? "TaskWraith")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 2)
                if stale {
                    Text("no contact")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.bottom, family == .systemSmall ? 8 : 10)

            if visibleRows.isEmpty {
                Spacer()
                Text("No recent runs.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                Spacer()
            } else {
                VStack(alignment: .leading, spacing: family == .systemSmall ? 10 : 12) {
                    ForEach(Array(visibleRows.enumerated()), id: \.offset) { index, row in
                        if family == .systemSmall && index == 0 {
                            heroRowView(row)
                        } else {
                            compactRowView(row)
                        }
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .padding(family == .systemSmall ? 14 : 16)
        .opacity(stale ? 0.55 : 1)
        .containerBackground(.background, for: .widget)
    }

    @ViewBuilder
    private func heroRowView(_ row: TWWidgetSnapshot.Row) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(row.title)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)

            HStack(spacing: 6) {
                statusCapsule(row)

                if let provider = row.providerLabel {
                    providerView(provider, tint: tint(row))
                }

                Spacer(minLength: 0)

                if let timestamp = row.updatedAt {
                    Text(ageString(from: timestamp, relativeTo: entry.date))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    @ViewBuilder
    private func compactRowView(_ row: TWWidgetSnapshot.Row) -> some View {
        if family == .systemMedium {
            HStack(spacing: 8) {
                statusCapsule(row)

                Text(row.title)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)

                Spacer(minLength: 4)

                if let provider = row.providerLabel {
                    providerView(provider, tint: tint(row))
                }

                if let timestamp = row.updatedAt {
                    Text(ageString(from: timestamp, relativeTo: entry.date))
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Text(row.title)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)

                HStack(spacing: 6) {
                    statusCapsule(row)

                    if let provider = row.providerLabel {
                        providerView(provider, tint: tint(row))
                    }

                    Spacer(minLength: 0)

                    if let timestamp = row.updatedAt {
                        Text(ageString(from: timestamp, relativeTo: entry.date))
                            .font(.system(size: 10))
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func statusCapsule(_ row: TWWidgetSnapshot.Row) -> some View {
        Text(statusLabel(row.status).uppercased())
            .font(.system(size: 9, weight: .bold, design: .rounded))
            .lineLimit(1)
            .minimumScaleFactor(0.75)
            .padding(.horizontal, 5)
            .padding(.vertical, 2.5)
            .background(tint(row).opacity(0.15))
            .foregroundStyle(tint(row))
            .clipShape(Capsule())
    }

    @ViewBuilder
    private func providerView(_ provider: String, tint: Color) -> some View {
        let isEnsemble = provider.lowercased() == "ensemble"
        Text(provider.prefix(1).uppercased() + provider.dropFirst())
            .font(.system(size: 9, weight: isEnsemble ? .bold : .medium, design: isEnsemble ? .rounded : .default))
            .lineLimit(1)
            .minimumScaleFactor(0.75)
            .padding(.horizontal, isEnsemble ? 4 : 0)
            .padding(.vertical, isEnsemble ? 2 : 0)
            .background(isEnsemble ? tint.opacity(0.15) : Color.clear)
            .foregroundStyle(isEnsemble ? tint : .secondary)
            .clipShape(Capsule())
    }

    private func tint(_ row: TWWidgetSnapshot.Row) -> Color {
        guard let hex = row.tintHex else { return .secondary.opacity(0.6) }
        return Color(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255)
    }

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "running": return "Running"
        case "completed", "success": return "Done"
        case "failed": return "Failed"
        case "queued": return "Queued"
        case "awaitingApproval": return "Needs approval"
        case "awaitingQuestion": return "Needs you"
        case "cancelled": return "Cancelled"
        default:
            return status.prefix(1).uppercased() + status.dropFirst()
        }
    }

    private func ageString(from timestamp: Int64, relativeTo date: Date) -> String {
        let age = date.timeIntervalSince1970 - Double(timestamp) / 1000
        if age < 60 { return "now" }
        if age < 3600 { return "\(Int(age / 60))m" }
        if age < 86400 { return "\(Int(age / 3600))h" }
        return "\(Int(age / 86400))d"
    }
}

struct TWGlanceWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TWGlanceWidget", provider: TWGlanceProvider()) { entry in
            TWGlanceView(entry: entry)
        }
        .configurationDisplayName("Agent status")
        .description("Running and recently finished TaskWraith runs.")
        .supportedFamilies([.systemSmall, .systemMedium])
        .contentMarginsDisabled()
    }
}
