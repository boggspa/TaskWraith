// Home-screen glance widget snapshot — the compact, routing-free state the
// APP writes into the shared App Group suite and the widget extension reads.
//
// Pure Foundation on purpose: the widget target links TaskWraithKit ONLY
// (same rule as the NSE — TWTheme is @MainActor + UIKit and must never cross
// into an extension), so every colour here is a hex the app resolved before
// writing. Tolerant decode: a snapshot written by a NEWER app must degrade,
// never throw the widget into placeholder purgatory.

import Foundation

public struct TWWidgetSnapshot: Codable, Sendable, Equatable {
    public struct Row: Codable, Sendable, Equatable, Identifiable {
        public let threadId: String?
        public let title: String
        /// "running" | "completed" | "failed" | anything a newer app invents
        /// (renders neutral).
        public let status: String
        public let providerLabel: String?
        /// Status tint resolved app-side (provider accent while running, the
        /// diff green/red when terminal).
        public let tintHex: UInt32?
        public let updatedAt: Int64?

        public var id: String { threadId ?? title }

        public init(
            threadId: String?, title: String, status: String,
            providerLabel: String?, tintHex: UInt32?, updatedAt: Int64?
        ) {
            self.threadId = threadId
            self.title = title
            self.status = status
            self.providerLabel = providerLabel
            self.tintHex = tintHex
            self.updatedAt = updatedAt
        }
    }

    public let generatedAt: Int64
    public let hostName: String?
    public let rows: [Row]

    public init(generatedAt: Int64, hostName: String?, rows: [Row]) {
        self.generatedAt = generatedAt
        self.hostName = hostName
        // The widget shows at most four; capping at WRITE keeps the defaults
        // payload bounded no matter how many threads the Mac projects.
        self.rows = Array(rows.prefix(Self.maxRows))
    }

    public static let maxRows = 4
    public static let storageKey = "tw.widget.snapshot.v1"
    /// Older than this and the widget dims + says "no recent contact" — the
    /// Live Activity staleness discipline, an order of magnitude looser.
    public static let staleAfterSeconds: Int64 = 30 * 60

    public func isStale(now: Date = Date()) -> Bool {
        let ageMs = Int64(now.timeIntervalSince1970 * 1000) - generatedAt
        return ageMs > Self.staleAfterSeconds * 1000
    }

    public func save(suiteName: String) {
        guard let defaults = UserDefaults(suiteName: suiteName),
            let data = try? JSONEncoder().encode(self)
        else { return }
        defaults.set(data, forKey: Self.storageKey)
    }

    public static func load(suiteName: String) -> TWWidgetSnapshot? {
        guard let defaults = UserDefaults(suiteName: suiteName),
            let data = defaults.data(forKey: storageKey)
        else { return nil }
        return try? JSONDecoder().decode(TWWidgetSnapshot.self, from: data)
    }
}
