// TWSharedCoders — the one place TaskWraithKit builds JSON coders, ISO-8601
// formatters, and retry delays, so hot paths re-call them instead of
// re-constructing them per message.
//
// Why this exists (perf round, 2026-08-26):
// `JSONDecoder()` / `JSONEncoder()` / `ISO8601DateFormatter()` are not free.
// Each construction allocates the object plus its strategy storage, and
// ISO8601DateFormatter additionally spins up an internal CFDateFormatter.
// Both relay ingest paths were building a brand-new decoder for EVERY inbound
// frame — the E2eeFrame decode in `RelayTransportClient.receiveLoop`, and then
// the per-token `bridge.runEvent` Wire decode in `RemoteSessionModel.handle`.
// A 10–20 thread Ensemble fan-out streams thousands of frames a second, so the
// phone paid thousands of throwaway allocations a second purely to parse what
// it was already parsing.
//
// CONTRACT — read this before adding to this file:
//   * Every instance below is configured ONCE, at construction, and is NEVER
//     mutated afterwards. Foundation's JSON coders and ISO8601DateFormatter are
//     safe for concurrent decode/encode/format only under exactly that
//     condition.
//   * A call site that needs a different strategy (key/date/data decoding, or
//     `.sortedKeys` output) gets its OWN dedicated static here. Never
//     reconfigure a shared instance at runtime — that silently races every
//     other caller on the phone.
//   * `nonisolated(unsafe)` follows the existing `TWThemeStore.shared`
//     precedent (TaskWraithUI/Theme.swift): the value is immutable after init,
//     so the global-actor check has nothing left to protect. It is spelled
//     only where the type is NOT Sendable (ISO8601DateFormatter) — this SDK's
//     JSONDecoder/JSONEncoder are Sendable, and the compiler warns the
//     annotation is unnecessary there.

import Foundation

/// Shared, immutably-configured coders. Each is behaviourally identical to the
/// freshly-constructed instance it replaced.
public enum TWCoders {
    /// Default-configured decoder — same key/date/data strategies a bare
    /// `JSONDecoder()` would have had at every call site that adopted it.
    public static let decoder = JSONDecoder()

    /// Default-configured encoder. Deliberately NOT `.sortedKeys` or
    /// `.prettyPrinted`: the frames this encodes go on the wire, and changing
    /// the byte layout would break the cross-implementation E2EE vectors that
    /// `InteropVectorsTests` pins against `src/shared/e2ee`.
    public static let encoder = JSONEncoder()

    /// Default-configured ISO-8601 formatter (`.withInternetDateTime`) — the
    /// exact behaviour of a fresh `ISO8601DateFormatter()`.
    ///
    /// Note the deliberate absence of a fractional-seconds variant here: the
    /// `withFractionalSeconds`-then-plain fallback pair is duplicated in
    /// ThreadRowTone/RemoteShellAppearance/TWSharedViews/
    /// TrustAwareTranscriptRowAdapter and unifying those is a separate slice —
    /// it needs its own parse-parity test before the fallback order can move.
    public nonisolated(unsafe) static let iso8601 = ISO8601DateFormatter()

    /// `iso8601.string(from: Date())` — the timestamp outbound envelopes stamp
    /// themselves with.
    public static func iso8601Now() -> String {
        iso8601.string(from: Date())
    }
}

/// The one retry/backoff delay for the iOS session layer.
///
/// Before this, the same `try? await Task.sleep(nanoseconds: <literal>)` shape
/// was hand-rolled at six retry/reconnect call sites in `RemoteSessionModel`,
/// each with its magic number written inline. This is a UNIFICATION, not a
/// retune: every
/// adopted call site keeps the exact delay it already had, and keeps the `try?`
/// swallow, so a cancelled sleep still returns immediately and the caller's own
/// `Task.isCancelled` check still decides what happens next.
///
/// NOT for coalescing/debounce windows. `StreamingPublishGate`, the projection
/// coalescers, and the thread-refresh debounce are latency budgets rather than
/// retries; they keep their own named constants on purpose, and folding them in
/// here would make one knob silently retune two unrelated behaviours.
public enum TWRetryDelay {
    public static let nanosecondsPerMillisecond: UInt64 = 1_000_000

    /// Cancellation-tolerant sleep. Returns immediately when the surrounding
    /// task is cancelled — callers check `Task.isCancelled` themselves.
    public static func sleep(nanoseconds: UInt64) async {
        try? await Task.sleep(nanoseconds: nanoseconds)
    }

    /// Millisecond spelling of the same sleep. Integer math, so the adopted
    /// literals convert exactly (250 ms → 250_000_000 ns).
    public static func sleep(milliseconds: UInt64) async {
        await sleep(nanoseconds: milliseconds * nanosecondsPerMillisecond)
    }
}
