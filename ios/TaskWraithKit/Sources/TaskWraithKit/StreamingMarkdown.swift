import Foundation

/// Splits a GROWING markdown stream into the settled prefix (safe to render
/// through the markdown pipeline — it won't change again) and the live tail
/// (still receiving tokens; rendered plain until its paragraph completes).
///
/// The boundary is the last blank line OUTSIDE a ``` code fence: splitting
/// inside an open fence would tear a code block in half and render its body
/// as paragraphs. Lists/tables stay in the tail until a blank line follows
/// them — a half-typed `**bold` or `| cell` never hits the markdown parser.
public enum StreamingMarkdownSplitter {
    public static func split(_ text: String) -> (settled: String, tail: String) {
        guard !text.isEmpty else { return ("", "") }
        var inFence = false
        var lastBoundary: String.Index? = nil
        var lineStart = text.startIndex
        while lineStart < text.endIndex {
            let lineEnd = text[lineStart...].firstIndex(of: "\n") ?? text.endIndex
            let line = text[lineStart..<lineEnd]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                inFence.toggle()
            } else if trimmed.isEmpty, !inFence, lineEnd < text.endIndex {
                // The settled prefix ends AFTER this blank line; the next
                // line starts the (possibly still-growing) tail.
                lastBoundary = text.index(after: lineEnd)
            }
            if lineEnd == text.endIndex { break }
            lineStart = text.index(after: lineEnd)
        }
        guard let boundary = lastBoundary else { return ("", text) }
        return (String(text[..<boundary]), String(text[boundary...]))
    }

    /// Incremental split for live streaming: re-scan the full text only when
    /// `text` is not an append-only growth of `previousText`, or when the
    /// growth crosses a new fence-aware paragraph boundary.
    public static func splitIncremental(
        previousSettled: String,
        previousText: String,
        text: String
    ) -> (settled: String, tail: String) {
        guard !text.isEmpty else { return ("", "") }
        if previousText.isEmpty || text.count < previousText.count || !text.hasPrefix(previousText) {
            return split(text)
        }
        if text == previousText {
            if previousSettled.isEmpty { return ("", text) }
            guard text.hasPrefix(previousSettled) else { return split(text) }
            return (previousSettled, String(text[previousSettled.endIndex...]))
        }

        let growth = String(text[previousText.endIndex...])
        if growthContainsNewSettlingBoundary(since: previousText, growth: growth) {
            return split(text)
        }

        if previousSettled.isEmpty {
            return ("", text)
        }
        guard text.hasPrefix(previousSettled) else { return split(text) }
        return (previousSettled, String(text[previousSettled.endIndex...]))
    }

    /// Whether `growth` (the suffix appended since `previousText`) introduces
    /// a new blank-line paragraph boundary outside an open ``` fence.
    static func growthContainsNewSettlingBoundary(since previousText: String, growth: String) -> Bool {
        guard !growth.isEmpty else { return false }
        if !growth.contains("\n\n") {
            if !(previousText.hasSuffix("\n") && growth.hasPrefix("\n")) { return false }
        }
        let inFence = fenceOpen(atEndOf: previousText)
        var scanningFence = inFence
        var lineStart = growth.startIndex
        while lineStart < growth.endIndex {
            let lineEnd = growth[lineStart...].firstIndex(of: "\n") ?? growth.endIndex
            let line = growth[lineStart..<lineEnd]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                scanningFence.toggle()
            } else if trimmed.isEmpty, !scanningFence, lineEnd < growth.endIndex {
                return true
            }
            if lineEnd == growth.endIndex { break }
            lineStart = growth.index(after: lineEnd)
        }
        return false
    }

    /// True when `text` ends inside an unclosed ``` fence.
    static func fenceOpen(atEndOf text: String) -> Bool {
        var inFence = false
        var lineStart = text.startIndex
        while lineStart < text.endIndex {
            let lineEnd = text[lineStart...].firstIndex(of: "\n") ?? text.endIndex
            let trimmed = text[lineStart..<lineEnd].trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") { inFence.toggle() }
            if lineEnd == text.endIndex { break }
            lineStart = text.index(after: lineEnd)
        }
        return inFence
    }
}

/// Holds the last incremental streaming split so token deltas extend the tail
/// without re-scanning the full growing bubble on every SwiftUI body eval.
@MainActor
public final class StreamingMarkdownSplitCacheBox {
    private var settledPrefix = ""
    private var lastText = ""

    public init() {}

    public func parts(for text: String) -> (settled: String, tail: String) {
        let result = StreamingMarkdownSplitter.splitIncremental(
            previousSettled: settledPrefix,
            previousText: lastText,
            text: text)
        settledPrefix = result.settled
        lastText = text
        return result
    }
}

/// Plans the LIVE transcript interleave: which stream text segment renders
/// between which of the run's tool rows, so the streaming view shows the
/// same order as the finished transcript.
///
/// Invariant from the stream side: tool event k seals segment k, so segment
/// k is the text BEFORE tool k and the last segment is the growing tail.
/// Snapshot tool rows may GROUP several consecutive tool calls (the Mac
/// collapses back-to-back tools into one row) — `toolCounts[r]` says how
/// many calls row r covers, and the segments between them are empty by
/// construction (no text between back-to-back calls).
public enum StreamingInterleave {
    public enum Element: Equatable, Sendable {
        /// Index into the caller's tool-row list.
        case toolRow(index: Int)
        /// Index into the segment list; `isTail` marks the growing edge.
        case text(segmentIndex: Int, isTail: Bool)
    }

    public static func plan(segments: [String], toolCounts: [Int]) -> [Element] {
        var out: [Element] = []
        let lastIndex = segments.count - 1
        func pushText(_ index: Int) {
            guard index >= 0, index < segments.count else { return }
            let trimmed = segments[index].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            out.append(.text(segmentIndex: index, isTail: index == lastIndex))
        }
        // The stream saw `segments.count - 1` tool boundaries. If the
        // snapshot claims MORE tool calls than that, the stream missed
        // early history (app attached mid-run, or a provider that doesn't
        // emit tool markers) — alignment is unknowable, so fall back to
        // the legacy order: rows first, then the live text.
        let claimed = toolCounts.reduce(0) { $0 + max(1, $1) }
        if claimed > max(0, segments.count - 1) {
            for index in toolCounts.indices { out.append(.toolRow(index: index)) }
            for index in segments.indices { pushText(index) }
            return out
        }
        var cursor = 0
        for (rowIndex, rawCount) in toolCounts.enumerated() {
            pushText(cursor)
            out.append(.toolRow(index: rowIndex))
            let consumed = max(1, rawCount)
            // Segments the Mac grouped past are empty by construction —
            // but never drop real text if the stream disagrees.
            var skipped = cursor + 1
            while skipped < cursor + consumed, skipped < segments.count {
                pushText(skipped)
                skipped += 1
            }
            cursor += consumed
        }
        var index = cursor
        while index < segments.count {
            pushText(index)
            index += 1
        }
        return out
    }
}

/// Reconciles an incoming live `content` delta against the streamed segment
/// list, distinguishing a genuine INCREMENT from an UNTAGGED CUMULATIVE
/// SNAPSHOT.
///
/// Most providers (Codex / Gemini / Kimi, and Claude's sliced stream) send
/// true increments — the new suffix only. But Cursor (cursor-agent
/// stream-json, no `--stream-partial-output`) re-states the WHOLE turn so far
/// in EVERY `assistant` frame, forwarded with no `cumulative` flag. Appending
/// such a frame blindly re-adds the pre-tool prose below each tool boundary
/// (text → tool → whole-turn-again), clumping/duplicating the bubble.
///
/// This mirrors the desktop's two pure helpers on the segment model:
///   - `resolveAssistantDeltaMerge`: equal/growing superset → replace; a
///     shorter prefix → skip a stale snapshot; otherwise append.
///   - `resolveAssistantDeltaTarget`: a snapshot spanning a tool boundary
///     contributes ONLY its post-last-tool tail — the pre-tool text already
///     lives in earlier sealed segments and is never rewritten.
///
/// Detection is on the RAW concatenation of segment contents (`segments
/// .joined()`), which is exactly the text Cursor's snapshot builds on — the
/// cosmetic `\n\n` joins the view inserts between segments are not part of it.
public enum StreamingSnapshotFold {
    public enum Decision: Equatable, Sendable {
        /// Genuine increment — append `incoming` to the last segment.
        case append
        /// Cumulative snapshot — set the last (post-tool) segment to this tail.
        case replaceLastSegment(String)
        /// Stale/duplicate snapshot already fully shown — ignore it.
        case skip
    }

    public static func plan(segments: [String], incoming: String) -> Decision {
        guard !incoming.isEmpty else { return .append }
        let rendered = segments.joined()
        // Nothing shown yet → first chunk; plain append onto the empty tail.
        if rendered.isEmpty { return .append }
        // A genuine delta is the NEW suffix and never restarts from the full
        // accumulated prose, so neither branch below matches it — only a
        // re-statement (equal or growing superset) does.
        if incoming.count >= rendered.count && incoming.hasPrefix(rendered) {
            // Cumulative snapshot. The text owned by EARLIER (sealed) segments
            // stays put; only the tail beyond them lands in the last segment.
            let earlier = segments.dropLast().joined()
            return .replaceLastSegment(String(incoming.dropFirst(earlier.count)))
        }
        // Incoming is a shorter prefix of what we already show — an older /
        // out-of-order snapshot we've surpassed. Drop it (the desktop skip).
        if incoming.count < rendered.count && rendered.hasPrefix(incoming) {
            return .skip
        }
        // Otherwise a genuine increment (or a new Codex item) — append.
        return .append
    }
}

/// Decides whether one compat-line content delta goes through
/// ``StreamingSnapshotFold`` (restatement shape detection) or appends
/// verbatim. Desktop parity: `trustedIncremental` (commit 77cca2171).
///
/// Main's adapters tag every full-turn restatement — `cumulative` on the
/// Claude divergent envelope (handled by the caller's skip, since the live
/// bubble already holds the streamed deltas), `runItemCumulative`/`snapshot`
/// on Cursor snapshot frames — and a six-provider audit found every other
/// re-send path is prefix-sliced before forwarding. So on a line that
/// verifiably came from the audited compat chokepoint, an UNTAGGED delta is a
/// verbatim increment and must append even when it byte-matches the bubble
/// (a repeated chunk like "test ", "test " was being fold-swallowed as a
/// stale snapshot). Lines without that provenance (legacy raw stdout) keep
/// the fold.
public enum StreamingDeltaRouting {
    public enum Decision: Equatable, Sendable {
        /// Reconcile via ``StreamingSnapshotFold`` — tagged snapshot
        /// restatements and all untrusted/legacy lines.
        case fold
        /// Verbatim increment from the audited compat lane — append as-is.
        case appendVerbatim
    }

    public static func decide(
        taggedSnapshotRestatement: Bool,
        trustedCompatLine: Bool
    ) -> Decision {
        if taggedSnapshotRestatement { return .fold }
        return trustedCompatLine ? .appendVerbatim : .fold
    }

    /// Provenance check: only the compat chokepoint synthesizes a non-empty
    /// assistant `item/delta` sidecar onto the wire line — the same
    /// structural marker the desktop derives `projectedFromRunItem` from.
    /// Legacy raw-stdout lines never carry `runItemEvents`.
    public static func hasAssistantDeltaSidecar(_ runItemEvents: Any?) -> Bool {
        guard let events = runItemEvents as? [[String: Any]] else { return false }
        return events.contains { event in
            (event["kind"] as? String) == "item/delta"
                && (event["channel"] as? String) == "assistant"
                && !(((event["delta"] as? String) ?? "").isEmpty)
        }
    }
}
