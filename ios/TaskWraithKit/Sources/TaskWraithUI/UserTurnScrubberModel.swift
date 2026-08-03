// Compact user-turn scrubber — pure models + layout.
//
// Desktop parity target: `src/renderer/src/lib/TranscriptUserMessageGutter.ts`
// (go-to-message rail). iOS needs a phone-scale compact scrubber that:
// - derives markers ONLY from currently loaded user rows (no inventing turns)
// - stays hidden when fewer than two user turns exist
// - bounds dense marker spacing for long threads
// - keeps stable row ids for jump targets
// - emits explicit jump intents (begin / end / marker) for the host scroll path
//
// New-file-only Priority-2 candidate — not wired into ThreadDetailViews here.

import Foundation

/// Minimum user turns before the scrubber is shown (desktop hides below 2).
public let userTurnScrubberMinimumTurns = 2

/// Honest input: one loaded transcript row the integrator already has in memory.
public struct UserTurnScrubberSourceRow: Equatable, Sendable, Identifiable {
    public var id: String
    /// Wire role — only `user` rows become markers.
    public var role: String
    /// Preview/title source (plain text; never markdown-rendered here).
    public var content: String
    /// Optional measured height; when nil, a uniform estimate is used.
    public var estimatedHeight: CGFloat

    public init(
        id: String,
        role: String,
        content: String = "",
        estimatedHeight: CGFloat = 64
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.estimatedHeight = estimatedHeight
    }
}

/// Stable marker the scrubber paints and jumps to.
public struct UserTurnScrubberMarker: Equatable, Sendable, Identifiable {
    /// Stable identity: same as `rowKey` for flat user rows.
    public var key: String
    public var messageId: String
    /// Positional row key `\(id)#\(positionalIndex)` — never ordinal alone.
    public var rowKey: String
    /// Positional index into the loaded rows array (scroll-anchor space).
    public var rowIndex: Int
    /// 1-based user-turn ordinal among loaded user rows only.
    public var ordinal: Int
    /// 0…100 midpoint along the loaded stack (uniform when heights equal).
    public var topPercent: Double
    public var title: String
    public var preview: String

    public var id: String { key }

    public init(
        key: String,
        messageId: String,
        rowKey: String,
        rowIndex: Int,
        ordinal: Int,
        topPercent: Double,
        title: String,
        preview: String
    ) {
        self.key = key
        self.messageId = messageId
        self.rowKey = rowKey
        self.rowIndex = rowIndex
        self.ordinal = ordinal
        self.topPercent = topPercent
        self.title = title
        self.preview = preview
    }
}

/// Explicit jump request — host owns the actual ScrollViewProxy / anchor work.
public enum UserTurnScrubberJumpIntent: Equatable, Sendable {
    /// Jump to the first loaded row (thread start).
    case begin
    /// Jump to the last loaded row (latest).
    case end
    /// Jump to a specific user-turn marker by stable row key / message id.
    case marker(UserTurnScrubberMarker)
}

public struct UserTurnScrubberMarkerLayout: Equatable, Sendable {
    public var key: String
    public var topPx: Double

    public init(key: String, topPx: Double) {
        self.key = key
        self.topPx = topPx
    }
}

public enum UserTurnScrubber {
    /// Stable row key for a loaded row at a positional index.
    public static func rowKey(messageId: String, positionalIndex: Int) -> String {
        "\(messageId)#\(positionalIndex)"
    }

    public static func isUserRole(_ role: String) -> Bool {
        role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user"
    }

    /// Compact title for accessibility / tooltips (desktop: first non-empty line, 96 chars).
    public static func title(for content: String) -> String {
        let firstLine = content
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { compactInline(String($0)) }
            .first { !$0.isEmpty }
        guard let firstLine else { return "User message" }
        return truncateInline(firstLine, maxChars: 96)
    }

    /// Short multi-line preview (bounded).
    public static func preview(for content: String) -> String {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "" }
        let lines = trimmed
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { compactInline(String($0)) }
            .filter { !$0.isEmpty }
        let taken = Array(lines.prefix(4))
        var joined = taken.joined(separator: "\n")
        if joined.count > 320 {
            joined = truncateInline(joined, maxChars: 320)
        }
        return joined
    }

    /// Build markers only from loaded user rows. Returns [] when hidden.
    public static func buildMarkers(
        from rows: [UserTurnScrubberSourceRow],
        rowHeights: [CGFloat]? = nil
    ) -> [UserTurnScrubberMarker] {
        guard !rows.isEmpty else { return [] }

        let heights: [CGFloat] = rows.enumerated().map { index, row in
            if let measured = rowHeights, index < measured.count, measured[index] > 0 {
                return measured[index]
            }
            return max(1, row.estimatedHeight)
        }
        let totalHeight = max(1, heights.reduce(0, +))
        var offsets: [CGFloat] = [0]
        for h in heights {
            offsets.append(offsets[offsets.count - 1] + h)
        }

        var markers: [UserTurnScrubberMarker] = []
        for (pos, row) in rows.enumerated() {
            guard isUserRole(row.role) else { continue }
            let rowTop = offsets[pos]
            let rowHeight = heights[pos]
            let midpoint = rowTop + max(0, rowHeight) / 2
            let topPercent = min(100, max(0, Double(midpoint / totalHeight) * 100))
            let key = rowKey(messageId: row.id, positionalIndex: pos)
            markers.append(
                UserTurnScrubberMarker(
                    key: key,
                    messageId: row.id,
                    rowKey: key,
                    rowIndex: pos,
                    ordinal: markers.count + 1,
                    topPercent: topPercent,
                    title: title(for: row.content),
                    preview: preview(for: row.content)
                )
            )
        }

        // Hidden below two user turns.
        if markers.count < userTurnScrubberMinimumTurns {
            return []
        }
        return markers
    }

    /// Whether the scrubber surface should mount for this marker set.
    public static func isVisible(markers: [UserTurnScrubberMarker]) -> Bool {
        markers.count >= userTurnScrubberMinimumTurns
    }

    /// Scroll-spy join: nearest marker at or above the anchor row index.
    public static func activeMarkerKey(
        markers: [UserTurnScrubberMarker],
        anchorRowIndex: Int
    ) -> String? {
        guard !markers.isEmpty else { return nil }
        var lo = 0
        var hi = markers.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if markers[mid].rowIndex <= anchorRowIndex {
                lo = mid + 1
            } else {
                hi = mid
            }
        }
        return lo > 0 ? markers[lo - 1].key : nil
    }

    /// Dense marker stack layout (px tops). Compact step shrinks with count.
    public static func layoutMarkers(
        _ markers: [UserTurnScrubberMarker],
        frameHeight: Double
    ) -> [UserTurnScrubberMarkerLayout] {
        guard !markers.isEmpty else { return [] }
        let height = frameHeight.isFinite && frameHeight > 0 ? frameHeight : 0
        let edgePad = min(8.0, height / 2)
        let available = max(0.0, height - edgePad * 2)
        if available <= 0 {
            return markers.map { UserTurnScrubberMarkerLayout(key: $0.key, topPx: edgePad) }
        }

        let step = compactMarkerStepPx(count: markers.count)
        let compactSpan = min(available, Double(max(0, markers.count - 1)) * step)
        let start = edgePad + available - compactSpan
        let stride = markers.count > 1 ? compactSpan / Double(markers.count - 1) : 0

        return markers.enumerated().map { index, marker in
            UserTurnScrubberMarkerLayout(
                key: marker.key,
                topPx: start + stride * Double(index)
            )
        }
    }

    public static func jumpIntent(for marker: UserTurnScrubberMarker) -> UserTurnScrubberJumpIntent {
        .marker(marker)
    }

    // MARK: - Internals

    private static func compactMarkerStepPx(count: Int) -> Double {
        if count >= 36 { return 5 }
        if count >= 28 { return 6 }
        if count >= 18 { return 8 }
        return 10
    }

    private static func compactInline(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func truncateInline(_ value: String, maxChars: Int) -> String {
        if value.count <= maxChars { return value }
        let end = value.index(value.startIndex, offsetBy: maxChars)
        var slice = String(value[..<end])
        if let lastSpace = slice.range(of: "\\s\\S*$", options: .regularExpression),
           slice.distance(from: slice.startIndex, to: lastSpace.lowerBound) > 24
        {
            slice = String(slice[..<lastSpace.lowerBound])
        }
        return slice.trimmingCharacters(in: .whitespacesAndNewlines) + "..."
    }
}
