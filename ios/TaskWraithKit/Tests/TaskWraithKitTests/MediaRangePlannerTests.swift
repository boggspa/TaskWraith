import Testing

@testable import TaskWraithKit

@Suite("MediaRangePlanner byte math")
struct MediaRangePlannerTests {
    // MARK: window

    @Test func normalBoundedWindow() {
        // currentOffset == requestedOffset, length well inside the asset.
        let w = MediaRangePlanner.window(
            currentOffset: 0, requestedOffset: 0, requestedLength: 1000,
            toEnd: false, totalBytes: 5000)
        #expect(w == MediaRangeWindow(start: 0, endExclusive: 1000))
        #expect(w.length == 1000)
        #expect(!w.isEmpty)
    }

    @Test func toEndIgnoresRequestedLengthAndRunsToTotal() {
        // requestsAllDataToEndOfResource: serve from start to totalBytes,
        // requestedLength irrelevant (here a stale 50).
        let w = MediaRangePlanner.window(
            currentOffset: 1024, requestedOffset: 1024, requestedLength: 50,
            toEnd: true, totalBytes: 4096)
        #expect(w == MediaRangeWindow(start: 1024, endExclusive: 4096))
    }

    @Test func currentOffsetAheadOfRequestedOffsetWins() {
        // AVF already consumed past requestedOffset → start at currentOffset.
        let w = MediaRangePlanner.window(
            currentOffset: 2048, requestedOffset: 1024, requestedLength: 2048,
            toEnd: false, totalBytes: 8192)
        // start = max(2048, 1024) = 2048; end = 1024 + 2048 = 3072.
        #expect(w == MediaRangeWindow(start: 2048, endExclusive: 3072))
    }

    @Test func currentOffsetBehindRequestedOffsetClampsToRequested() {
        // currentOffset < requestedOffset (fresh seek) → start at requestedOffset.
        let w = MediaRangePlanner.window(
            currentOffset: 0, requestedOffset: 1024, requestedLength: 512,
            toEnd: false, totalBytes: 8192)
        #expect(w == MediaRangeWindow(start: 1024, endExclusive: 1536))
    }

    @Test func requestedLengthBeyondTotalClampsToTotal() {
        // requestedOffset + requestedLength runs past the asset → clamp end.
        let w = MediaRangePlanner.window(
            currentOffset: 4000, requestedOffset: 4000, requestedLength: 5000,
            toEnd: false, totalBytes: 4500)
        #expect(w == MediaRangeWindow(start: 4000, endExclusive: 4500))
        #expect(w.length == 500)
    }

    @Test func offsetAtTotalYieldsEmptyWindow() {
        let w = MediaRangePlanner.window(
            currentOffset: 5000, requestedOffset: 5000, requestedLength: 1000,
            toEnd: false, totalBytes: 5000)
        #expect(w.start == 5000)
        #expect(w.endExclusive == 5000)
        #expect(w.isEmpty)
        #expect(w.length == 0)
    }

    @Test func offsetOverTotalClampsBothBoundsToTotal() {
        let w = MediaRangePlanner.window(
            currentOffset: 9000, requestedOffset: 9000, requestedLength: 1000,
            toEnd: false, totalBytes: 5000)
        #expect(w == MediaRangeWindow(start: 5000, endExclusive: 5000))
        #expect(w.isEmpty)
    }

    @Test func negativeInputsClampToZero() {
        let w = MediaRangePlanner.window(
            currentOffset: -100, requestedOffset: -50, requestedLength: -10,
            toEnd: false, totalBytes: 4096)
        // start = clamp(max(-100,-50)=-50) → 0; end = max(start, clamp(-50 + -10)) → 0.
        #expect(w == MediaRangeWindow(start: 0, endExclusive: 0))
        #expect(w.isEmpty)
    }

    @Test func negativeStartWithPositiveSpanStillServes() {
        // A negative currentOffset must not poison a legitimate window.
        let w = MediaRangePlanner.window(
            currentOffset: -5, requestedOffset: 0, requestedLength: 256,
            toEnd: false, totalBytes: 4096)
        #expect(w == MediaRangeWindow(start: 0, endExclusive: 256))
    }

    @Test func zeroTotalIsAlwaysEmpty() {
        let w = MediaRangePlanner.window(
            currentOffset: 0, requestedOffset: 0, requestedLength: 1000,
            toEnd: true, totalBytes: 0)
        #expect(w == MediaRangeWindow(start: 0, endExclusive: 0))
        #expect(w.isEmpty)
    }

    @Test func hugeRequestedLengthDoesNotOverflow() {
        // requestedOffset + Int.max must saturate, not trap, then clamp to total.
        let w = MediaRangePlanner.window(
            currentOffset: 10, requestedOffset: 10, requestedLength: Int.max,
            toEnd: false, totalBytes: 4096)
        #expect(w == MediaRangeWindow(start: 10, endExclusive: 4096))
    }

    // MARK: nextChunkLength

    @Test func fullChunkMidWindow() {
        let w = MediaRangeWindow(start: 0, endExclusive: 2_000_000)
        #expect(MediaRangePlanner.nextChunkLength(offset: 0, window: w, chunkSize: 448 * 1024) == 448 * 1024)
        #expect(MediaRangePlanner.nextChunkLength(offset: 448 * 1024, window: w, chunkSize: 448 * 1024) == 448 * 1024)
    }

    @Test func partialLastChunk() {
        let w = MediaRangeWindow(start: 0, endExclusive: 500)
        // Only 500 - 300 = 200 left; chunkSize would allow 448 KiB.
        #expect(MediaRangePlanner.nextChunkLength(offset: 300, window: w, chunkSize: 448 * 1024) == 200)
    }

    @Test func offsetAtEndExclusiveYieldsZero() {
        let w = MediaRangeWindow(start: 0, endExclusive: 1000)
        #expect(MediaRangePlanner.nextChunkLength(offset: 1000, window: w, chunkSize: 448 * 1024) == 0)
    }

    @Test func offsetPastEndExclusiveYieldsZero() {
        let w = MediaRangeWindow(start: 0, endExclusive: 1000)
        #expect(MediaRangePlanner.nextChunkLength(offset: 1500, window: w, chunkSize: 448 * 1024) == 0)
    }

    @Test func nonPositiveChunkSizeYieldsZero() {
        let w = MediaRangeWindow(start: 0, endExclusive: 1000)
        #expect(MediaRangePlanner.nextChunkLength(offset: 0, window: w, chunkSize: 0) == 0)
        #expect(MediaRangePlanner.nextChunkLength(offset: 0, window: w, chunkSize: -5) == 0)
    }

    @Test func emptyWindowAlwaysYieldsZero() {
        let w = MediaRangeWindow(start: 5000, endExclusive: 5000)
        #expect(MediaRangePlanner.nextChunkLength(offset: 5000, window: w, chunkSize: 448 * 1024) == 0)
    }

    @Test func chunkExactlyFillsRemainder() {
        let w = MediaRangeWindow(start: 0, endExclusive: 1000)
        #expect(MediaRangePlanner.nextChunkLength(offset: 600, window: w, chunkSize: 400) == 400)
        #expect(MediaRangePlanner.nextChunkLength(offset: 1000, window: w, chunkSize: 400) == 0)
    }
}
