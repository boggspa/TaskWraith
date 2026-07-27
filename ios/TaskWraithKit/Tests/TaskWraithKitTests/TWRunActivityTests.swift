import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Run activity contract")
struct TWRunActivityTests {
    private let start = Date(timeIntervalSince1970: 1_700_000_000)

    @Test("progress is nil for a solo run — no denominator means no bar")
    func soloRunHasNoProgress() {
        let state = makeContentState(
            phase: .running, startedAt: start, filesChanged: 3, additions: 10, deletions: 2)
        #expect(state.progress == nil)
    }

    @Test("progress is real for an ensemble: finished / total")
    func ensembleProgress() {
        let state = makeContentState(
            phase: .running, startedAt: start,
            seats: [
                TWSeatState(provider: "codex", phase: .complete),
                TWSeatState(provider: "claude", phase: .complete),
                TWSeatState(provider: "cursor", phase: .running),
                TWSeatState(provider: "kimi", phase: .failed)
            ])
        // failed is terminal — the seat is DONE, it just didn't succeed. A bar
        // that stalls at 50% because one seat errored would misreport the run.
        #expect(state.seatsFinished == 3)
        #expect(state.progress == 0.75)
    }

    @Test("seats are capped so an oversized ensemble cannot blow the payload")
    func seatsCapped() {
        let many = (0..<40).map { TWSeatState(provider: "p\($0)", phase: .running) }
        let state = makeContentState(phase: .running, startedAt: start, seats: many)
        #expect(state.seats.count == TWRunActivityLimits.maxSeats)
    }

    @Test("negative counts are clamped rather than rendered")
    func negativeCountsClamped() {
        let state = makeContentState(
            phase: .running, startedAt: start, filesChanged: -5, additions: -1, deletions: -9)
        #expect(state.filesChanged == 0)
        #expect(state.additions == 0)
        #expect(state.deletions == 0)
    }

    @Test("needsUser is true exactly for the two waiting phases")
    func needsUser() {
        #expect(TWRunPhase.awaitingApproval.needsUser)
        #expect(TWRunPhase.awaitingQuestion.needsUser)
        for phase in [TWRunPhase.running, .complete, .failed, .cancelled] {
            #expect(!phase.needsUser)
        }
    }

    @Test("isTerminal covers every finished phase")
    func isTerminal() {
        for phase in [TWRunPhase.complete, .failed, .cancelled] {
            #expect(phase.isTerminal)
        }
        for phase in [TWRunPhase.running, .awaitingApproval, .awaitingQuestion] {
            #expect(!phase.isTerminal)
        }
    }

    /// THE CONTAINMENT TEST. A Live Activity payload cannot be encrypted, so
    /// this pins the serialised shape: if someone adds a field carrying user
    /// content, this fails and they have to read the rule at the top of
    /// TWRunActivity.swift before they can make it pass.
    @Test("content state serialises to allowlisted keys ONLY")
    func contentStateKeysAreAllowlisted() throws {
        let state = makeContentState(
            phase: .running, startedAt: start, filesChanged: 1, additions: 2, deletions: 3,
            seats: [TWSeatState(provider: "codex", phase: .running)])
        let data = try JSONEncoder().encode(state)
        let object = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(
            Set(object.keys) == [
                "phase", "startedAtUnix", "filesChanged", "additions", "deletions", "seats"
            ])
        // Must serialise as a NUMBER of unix seconds. A `Date` here would encode
        // via whatever strategy the decoder uses; ActivityKit's default reads a
        // bare number as seconds since 2001, putting the timer 31 years out.
        #expect(object["startedAtUnix"] as? Int == 1_700_000_000)
        let seats = try #require(object["seats"] as? [[String: Any]])
        #expect(Set(seats[0].keys) == ["provider", "phase"])
    }

    @Test("config carries an opaque ref, and round-trips")
    func configRoundTrips() throws {
        let config = TWRunActivityConfig(
            provider: "codex", archetype: .ensemble,
            palette: TWActivityPalette(
                accent: 0x705AFF, success: 0x2DB777, failure: 0xEC3D35, attention: 0xF5A623),
            activityRef: "opaque-123")
        let decoded = try JSONDecoder().decode(
            TWRunActivityConfig.self, from: try JSONEncoder().encode(config))
        #expect(decoded == config)
    }

    /// ActivityKit persists attributes and replays them through
    /// `Activity.activities` after an app update. A throwing decode would hide
    /// the activity from the new build, leaving a dead run stuck on the lock
    /// screen with no code able to end it — so missing fields MUST default.
    @Test("a config written by an older build still decodes")
    func configDecodesWithoutPalette() throws {
        let legacy = Data(
            #"{"provider":"claude","archetype":"diff","activityRef":"r1"}"#.utf8)
        let decoded = try JSONDecoder().decode(TWRunActivityConfig.self, from: legacy)
        #expect(decoded.provider == "claude")
        #expect(decoded.palette == TWActivityPalette.fallback)
    }

    @Test("an unknown archetype from a newer build falls back rather than throwing")
    func configDecodesUnknownArchetype() throws {
        let future = Data(
            #"{"provider":"codex","archetype":"holographic","activityRef":"r2"}"#.utf8)
        let decoded = try JSONDecoder().decode(TWRunActivityConfig.self, from: future)
        #expect(decoded.archetype == TWActivityArchetype.fallback)
    }

    /// The palette exists so the widget never needs a colour table of its own.
    /// These are the desktop's published values (theme.css --diff-stat-*-color
    /// and --status-attention); if they drift, the lock screen stops matching
    /// the app it is reporting on.
    @Test("fallback palette matches the desktop tokens")
    func fallbackPaletteMatchesDesktop() {
        #expect(TWActivityPalette.fallback.success == 0x2DB777)
        #expect(TWActivityPalette.fallback.failure == 0xEC3D35)
        #expect(TWActivityPalette.fallback.attention == 0xF5A623)
    }

    @Test("every archetype has a stable wire id")
    func archetypeIds() {
        #expect(
            Set(TWActivityArchetype.allCases.map(\.rawValue))
                == ["minimal", "diff", "attention", "ensemble"])
        // A template synced from a newer build naming an unknown archetype must
        // decode to nil so the widget can fall back rather than fail to render.
        #expect(TWActivityArchetype(rawValue: "holographic") == nil)
        #expect(TWActivityArchetype.fallback == .diff)
    }
}
