// TWSharedCoders — the regression net for the shared-coder contract.
//
// The perf slice that introduced TWCoders replaced ~35 freshly-constructed
// `JSONDecoder()` / `JSONEncoder()` / `ISO8601DateFormatter()` instances on the
// relay ingest path with four shared ones. That is only safe while the shared
// instances stay configured EXACTLY like the default ones they replaced — a
// later `TWCoders.encoder.outputFormatting = .sortedKeys` or a
// `dateDecodingStrategy` tweak would silently re-tune every one of those call
// sites at once, including the E2EE frames that go on the wire.
//
// So these tests do not assert the shared coders "work"; they assert they are
// still INDISTINGUISHABLE from a fresh default coder, and that they are still
// shared rather than quietly re-allocated per access.

import Foundation
import Testing

@testable import TaskWraithKit

private struct CoderSample: Codable, Equatable {
    let id: String
    let count: Int
    // Pins dateEncodingStrategy/dateDecodingStrategy parity — the strategy most
    // likely to be "helpfully" changed on a shared instance later.
    let when: Date
    let flag: Bool?
}

@Suite("Shared coders")
struct TWSharedCodersTests {
    private var sample: CoderSample {
        CoderSample(
            id: "thread-1", count: 42,
            when: Date(timeIntervalSinceReferenceDate: 771_000_000), flag: true)
    }

    @Test("the shared coders are shared, not rebuilt per access")
    func instancesAreStable() {
        #expect(TWCoders.decoder === TWCoders.decoder)
        #expect(TWCoders.encoder === TWCoders.encoder)
        #expect(TWCoders.iso8601 === TWCoders.iso8601)
    }

    @Test("the shared encoder stays default-configured and default-decodable")
    func encoderMatchesDefault() throws {
        // NOT a byte-parity check on purpose: Foundation's default JSONEncoder
        // key order is hash-seeded and unstable BETWEEN encoder instances even
        // in one process (measured in this suite: `count`/`when` swapped
        // between runs). Every pre-TWCoders call site built a fresh encoder,
        // so the wire never had cross-instance byte stability to preserve.
        // The real contract is default CONFIGURATION: pin the mutable knob a
        // future "helpful" tweak would touch, and prove a fresh default
        // decoder reads the shared encoder's output exactly.
        #expect(TWCoders.encoder.outputFormatting == [])
        let viaDefault = try JSONDecoder().decode(
            CoderSample.self, from: TWCoders.encoder.encode(sample))
        #expect(viaDefault == sample)
    }

    @Test("the shared decoder round-trips exactly like a fresh default decoder")
    func decoderMatchesDefault() throws {
        let data = try JSONEncoder().encode(sample)
        let viaShared = try TWCoders.decoder.decode(CoderSample.self, from: data)
        let viaFresh = try JSONDecoder().decode(CoderSample.self, from: data)
        #expect(viaShared == viaFresh)
        #expect(viaShared == sample)
    }

    @Test("a decode failure still throws rather than being swallowed by sharing")
    func decoderStillThrowsOnGarbage() {
        let garbage = Data(#"{"id":"x"}"#.utf8)
        #expect(throws: (any Error).self) {
            _ = try TWCoders.decoder.decode(CoderSample.self, from: garbage)
        }
    }

    @Test("the shared ISO-8601 formatter matches a fresh default formatter")
    func iso8601MatchesDefault() {
        let instant = Date(timeIntervalSinceReferenceDate: 771_000_000)
        #expect(TWCoders.iso8601.string(from: instant) == ISO8601DateFormatter().string(from: instant))
    }

    @Test("iso8601Now produces a parseable internet date-time")
    func iso8601NowRoundTrips() {
        let stamped = TWCoders.iso8601Now()
        #expect(ISO8601DateFormatter().date(from: stamped) != nil)
    }
}

@Suite("Retry delay")
struct TWRetryDelayTests {
    // Pins the exact delays the six adopted RemoteSessionModel call sites had
    // BEFORE unification. If this arithmetic ever drifts, the reconnect walk,
    // the APNs retry and the resync backoff all silently retune together.
    @Test("adopted call-site delays convert exactly")
    func adoptedDelaysAreUnchanged() {
        #expect(250 * TWRetryDelay.nanosecondsPerMillisecond == 250_000_000)
        #expect(1_200 * TWRetryDelay.nanosecondsPerMillisecond == 1_200_000_000)
        #expect(5_000 * TWRetryDelay.nanosecondsPerMillisecond == 5_000_000_000)
    }

    @Test("a cancelled delay returns promptly instead of serving the full wait")
    func cancelledDelayReturnsPromptly() async {
        let started = Date()
        let task = Task { await TWRetryDelay.sleep(milliseconds: 5_000) }
        task.cancel()
        await task.value
        // Nominal wait is 5s; anything under 2s proves cancellation short-circuits
        // it, without making the assertion timing-sensitive on a loaded CI box.
        #expect(Date().timeIntervalSince(started) < 2.0)
    }

    @Test("an uncancelled delay actually waits")
    func uncancelledDelayWaits() async {
        let started = Date()
        await TWRetryDelay.sleep(milliseconds: 60)
        #expect(Date().timeIntervalSince(started) >= 0.03)
    }
}
