// MediaRangePlanner — the pure byte-math core for streaming a sha-addressed
// media asset to AVFoundation in bounded chunks over the E2EE bridge.
//
// AVAssetResourceLoaderDelegate hands us absolute byte windows
// (AVAssetResourceLoadingDataRequest); the bridge serves slices hard-clamped to
// 448 KiB server-side. This file owns ZERO AVFoundation — it just computes,
// from the request's offsets and the asset's total size, the closed-open byte
// window to serve and the length of the next chunk to request. Kept pure +
// defensive so it lives in `TaskWraithKit` and is `swift test`-able without
// AVFoundation (mirrors RevealParams).
//
// Every input is clamped into `[0, totalBytes]`: AVFoundation can ask for a
// window that runs past the end of the resource (e.g. requestsAllDataToEnd with
// a stale length), and the bridge must never be asked for a byte the asset
// doesn't have.

import Foundation

/// A closed-open byte window `[start, endExclusive)` to serve for one
/// AVAssetResourceLoadingDataRequest. Both bounds are already clamped into
/// `[0, totalBytes]` by ``MediaRangePlanner/window(currentOffset:requestedOffset:requestedLength:toEnd:totalBytes:)``.
public struct MediaRangeWindow: Sendable, Equatable {
    /// First byte to serve.
    public let start: Int
    /// One past the last byte to serve (clamped to `totalBytes`).
    public let endExclusive: Int
    /// True when there is nothing to serve.
    public var isEmpty: Bool { endExclusive <= start }
    /// Number of bytes in the window (never negative).
    public var length: Int { max(0, endExclusive - start) }
    public init(start: Int, endExclusive: Int) {
        self.start = start
        self.endExclusive = endExclusive
    }
}

public enum MediaRangePlanner {
    /// The byte window to serve for ONE `AVAssetResourceLoadingDataRequest`.
    ///
    /// - Parameters:
    ///   - currentOffset: where AVFoundation expects the next byte
    ///     (`dataRequest.currentOffset`).
    ///   - requestedOffset: the request's absolute window start
    ///     (`dataRequest.requestedOffset`).
    ///   - requestedLength: the request's absolute window length
    ///     (`dataRequest.requestedLength`); ignored when `toEnd` is true.
    ///   - toEnd: `dataRequest.requestsAllDataToEndOfResource` — serve to
    ///     `totalBytes` regardless of `requestedLength`.
    ///   - totalBytes: asset size (`>= 0`).
    /// - Returns: a window whose bounds are clamped into `[0, totalBytes]` and
    ///   whose `endExclusive >= start`; never exceeds `totalBytes`.
    public static func window(
        currentOffset: Int, requestedOffset: Int, requestedLength: Int,
        toEnd: Bool, totalBytes: Int
    ) -> MediaRangeWindow {
        // Defensive floor: a negative totalBytes (impossible from the bridge,
        // but cheap to guard) collapses every window to empty.
        let total = max(0, totalBytes)
        // Start where AVF wants the next byte, but never before the request's
        // own absolute offset; clamp into the asset.
        let rawStart = max(currentOffset, requestedOffset)
        let start = clamp(rawStart, lower: 0, upper: total)
        // End: serve to the asset end when toEnd, else honour the absolute
        // window, clamped into the asset and never below `start`.
        let rawEnd = toEnd ? total : addClamped(requestedOffset, requestedLength)
        let end = max(start, clamp(rawEnd, lower: 0, upper: total))
        return MediaRangeWindow(start: start, endExclusive: end)
    }

    /// Bytes to request for the next chunk starting at `offset`, capped by
    /// `chunkSize`. Returns 0 when `offset` has reached/passed
    /// `window.endExclusive`, or when `chunkSize <= 0`.
    public static func nextChunkLength(
        offset: Int, window: MediaRangeWindow, chunkSize: Int
    ) -> Int {
        guard chunkSize > 0 else { return 0 }
        return max(0, min(chunkSize, window.endExclusive - offset))
    }

    // MARK: - Defensive integer helpers

    private static func clamp(_ value: Int, lower: Int, upper: Int) -> Int {
        min(max(value, lower), upper)
    }

    /// `a + b` without trapping on overflow — a stale/garbage requestedLength
    /// must not crash the loader. Saturates at `Int.max`, floors at 0.
    private static func addClamped(_ a: Int, _ b: Int) -> Int {
        let (sum, overflow) = a.addingReportingOverflow(b)
        if overflow { return a >= 0 && b >= 0 ? Int.max : 0 }
        return max(0, sum)
    }
}
