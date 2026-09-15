import Foundation
import SwiftUI

#if canImport(UIKit)
    import UIKit
#elseif canImport(AppKit)
    import AppKit
#endif

/// One line of the on-device connection log. Text-only on purpose: the whole
/// ring is copied straight out of Settings into a bug report, so it must read
/// without any decoding step.
public struct ConnectionLogEntry: Identifiable, Equatable, Sendable {
    public let id: UInt64
    public let at: Date
    public let kind: String
    public let detail: String

    public init(id: UInt64, at: Date, kind: String, detail: String) {
        self.id = id
        self.at = at
        self.kind = kind
        self.detail = detail
    }
}

/// Bounded ring of reconnect decisions, dials, establishes, probe verdicts and
/// teardowns. Every earlier reconnect-storm fix was verified only against a
/// synthetic unroutable relay; this is the evidence channel that lets a fix be
/// checked on the phone that actually storms.
public struct ConnectionLog: Equatable, Sendable {
    public static let defaultCapacity = 1_000

    public private(set) var entries: [ConnectionLogEntry] = []
    public let capacity: Int
    private var nextId: UInt64 = 0

    public init(capacity: Int = ConnectionLog.defaultCapacity) {
        self.capacity = max(1, capacity)
    }

    public mutating func append(_ kind: String, _ detail: String = "", at now: Date = Date()) {
        entries.append(ConnectionLogEntry(id: nextId, at: now, kind: kind, detail: detail))
        nextId &+= 1
        if entries.count > capacity {
            entries.removeFirst(entries.count - capacity)
        }
    }

    public mutating func clear() {
        entries.removeAll()
    }

    /// Oldest first, one entry per line, wall-clock with millisecond precision
    /// so back-to-back decisions inside one wake stay distinguishable.
    public func exportText() -> String {
        entries.map { Self.line(for: $0) }.joined(separator: "\n")
    }

    static func line(for entry: ConnectionLogEntry) -> String {
        let stamp = Self.stampFormatter.string(from: entry.at)
        return entry.detail.isEmpty
            ? "\(stamp) \(entry.kind)"
            : "\(stamp) \(entry.kind) \(entry.detail)"
    }

    nonisolated(unsafe) private static let stampFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()
}

/// The model's log, behind its own `ObservableObject` so appending an entry
/// re-renders only the Settings card and this viewer — never the whole tree
/// that observes `RemoteSessionModel` (probe verdicts land several times a
/// second during a sync).
@MainActor
public final class ConnectionLogStore: ObservableObject {
    @Published public private(set) var log = ConnectionLog()

    public init() {}

    public func append(_ kind: String, _ detail: String = "") {
        log.append(kind, detail)
    }

    public func clear() {
        log.clear()
    }
}

/// Read-only viewer for the connection log with copy-out and clear. Presented
/// from Settings → Remote.
public struct ConnectionLogView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var store: ConnectionLogStore
    @State private var copied = false

    public init(store: ConnectionLogStore) {
        self.store = store
    }

    public var body: some View {
        NavigationStack {
            Group {
                if store.log.entries.isEmpty {
                    ContentUnavailableView(
                        "No connection events yet",
                        systemImage: "waveform.path.ecg",
                        description: Text(
                            "Reconnect decisions, dials, establishes and probe verdicts appear here as they happen."
                        ))
                } else {
                    ScrollViewReader { proxy in
                        List(store.log.entries) { entry in
                            Text(ConnectionLog.line(for: entry))
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(TWTheme.textPrimary)
                                .textSelection(.enabled)
                                .listRowBackground(Color.clear)
                                .id(entry.id)
                        }
                        .listStyle(.plain)
                        .onAppear {
                            if let last = store.log.entries.last {
                                proxy.scrollTo(last.id, anchor: .bottom)
                            }
                        }
                    }
                }
            }
            .background(TWTheme.appBg.ignoresSafeArea())
            .navigationTitle("Connection log")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button {
                        copyLog()
                    } label: {
                        Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                    .disabled(store.log.entries.isEmpty)
                    Button(role: .destructive) {
                        store.clear()
                    } label: {
                        Label("Clear", systemImage: "trash")
                    }
                    .disabled(store.log.entries.isEmpty)
                }
            }
        }
        .twColorScheme()
    }

    private func copyLog() {
        let text = store.log.exportText()
        #if canImport(UIKit)
            UIPasteboard.general.string = text
        #elseif canImport(AppKit)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        #endif
        copied = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            copied = false
        }
    }
}
