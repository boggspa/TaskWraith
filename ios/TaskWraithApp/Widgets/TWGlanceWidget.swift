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
                    providerLabel: "Claude", tintHex: 0x5A8CFF,
                    updatedAt: Int64(Date().timeIntervalSince1970 * 1000)),
                TWWidgetSnapshot.Row(
                    threadId: "b", title: "Ship the release notes", status: "completed",
                    providerLabel: "Codex", tintHex: 0x2DB777,
                    updatedAt: Int64(Date().timeIntervalSince1970 * 1000)),
            ])
    }
}

private struct TWGlanceView: View {
    let entry: TWGlanceEntry
    @Environment(\.widgetFamily) private var family

    private var snapshot: TWWidgetSnapshot? { entry.snapshot }
    private var stale: Bool { snapshot?.isStale(now: entry.date) ?? false }
    private var visibleRows: [TWWidgetSnapshot.Row] {
        let limit = family == .systemSmall ? 2 : TWWidgetSnapshot.maxRows
        return Array((snapshot?.rows ?? []).prefix(limit))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
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
            if visibleRows.isEmpty {
                Spacer()
                Text("No recent runs.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
            } else {
                ForEach(visibleRows) { row in
                    HStack(spacing: 6) {
                        Circle()
                            .fill(tint(row))
                            .frame(width: 7, height: 7)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(row.title)
                                .font(.caption.weight(.medium))
                                .lineLimit(1)
                            HStack(spacing: 3) {
                                if let provider = row.providerLabel {
                                    Text(provider)
                                }
                                Text(statusLabel(row.status))
                            }
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .padding(2)
        .opacity(stale ? 0.55 : 1)
        .containerBackground(.background, for: .widget)
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
            // A status a newer app invents renders as itself, neutrally.
            return status.prefix(1).uppercased() + status.dropFirst()
        }
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
    }
}
