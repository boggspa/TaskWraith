import Foundation
import Testing

@testable import TaskWraithKit
@testable import TaskWraithUI

/// Regression cover for the post-host-restart reconnect storm (2026-07-28).
///
/// Every phone→host action funnels through `requestActionAckWithWake`. Its
/// peer-liveness preflight (`checkPeerAlive`) fails instantly for any request
/// whose client was torn down underneath it, so an establish-time burst of
/// actions used to produce a burst of INDEPENDENT `reconnectTrusted()` dials —
/// each tearing down the client the others were waiting on. The host log showed
/// the result: 152 E2EE establishes over ONE live transport, 38 overlapping-
/// handshake `clientAuth signature invalid` rejections, and finally a watchdog
/// kill of the iOS app.
///
/// The recovery now routes through `ReconnectCoordinator`, so N concurrent
/// failures collapse to exactly one dial.
@Suite("Reconnect storm containment")
@MainActor
struct ReconnectStormTests {
    /// The candidate is a public cleartext `ws://` host, which the ATS preflight
    /// (`cleartextRelayProblem`) rejects before any socket is opened — the dial
    /// walk fails synchronously, so these tests never touch the network.
    private static let unroutableRelay = "ws://reconnect-storm.invalid:9"

    @Test("a burst of host-unavailable actions collapses to one trusted dial")
    func actionBurstCollapsesToOneDial() async {
        let model = makePairedModel()

        // Five actions from one establish (setWatchedThread, threadSnapshot,
        // gitSnapshot, the APNs registration, a user tap) all fail their
        // liveness preflight in the same MainActor turn.
        for _ in 0..<5 {
            model.recoverFromUnavailableHostForActionForTesting()
        }

        #expect(model.trustedReconnectDialsForTesting == 1)
        await quiesce(model)
    }

    @Test("the coalesced siblings still land on the one in-flight dial")
    func coalescedSiblingsSeeConnectingPhase() async {
        let model = makePairedModel()

        model.recoverFromUnavailableHostForActionForTesting()
        // The first recovery flips the phase synchronously; that is what makes
        // the siblings coalesce rather than supersede.
        #expect(isConnecting(model.phase))

        model.recoverFromUnavailableHostForActionForTesting()
        #expect(model.trustedReconnectDialsForTesting == 1)
        #expect(isConnecting(model.phase))
        await quiesce(model)
    }

    @Test("an unpaired phone never dials from a failed action")
    func unpairedPhoneDoesNotDial() {
        let model = makeModel(seedPairing: false)
        model.recoverFromUnavailableHostForActionForTesting()
        #expect(model.trustedReconnectDialsForTesting == 0)
    }

    /// The coordinator policy the fix leans on, in the storm's exact shape:
    /// a `.health` wake with `socketAlive: false` starts one dial from
    /// `.connected` and is IGNORED for every sibling once the dial is running.
    @Test("coordinator ignores sibling health failures during the dial")
    func coordinatorIgnoresSiblingHealthFailures() {
        var coord = ReconnectCoordinator()
        let t0 = Date(timeIntervalSince1970: 1_700_000_000)

        #expect(
            coord.evaluate(reason: .health, phase: .connected, now: t0, socketAlive: false)
                == .start)
        coord.markAttemptStarted(at: t0)

        for i in 1...4 {
            let now = t0.addingTimeInterval(Double(i) * 0.01)
            #expect(
                coord.evaluate(
                    reason: .health, phase: .connecting, now: now, socketAlive: false) == .ignore)
        }
        #expect(coord.inFlight)
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    /// Let the (network-free) dial walk finish, then stop the model dialling.
    /// A failed walk arms `scheduleAutoReconnect`, and swift-testing runs suites
    /// concurrently on the MainActor — a model left retrying in the background
    /// starves the timing-sensitive streaming-gate suites next door.
    private func quiesce(_ model: RemoteSessionModel) async {
        try? await Task.sleep(nanoseconds: 20_000_000)
        model.forgetAllHosts()
    }

    private func isConnecting(_ phase: SessionPhase) -> Bool {
        if case .connecting = phase { return true }
        return false
    }

    private func makePairedModel() -> RemoteSessionModel {
        makeModel(seedPairing: true)
    }

    private func makeModel(seedPairing: Bool) -> RemoteSessionModel {
        let defaults = UserDefaults(suiteName: "ReconnectStormTests.\(UUID().uuidString)")!
        let store = UserDefaultsPairedHostStore(defaults: defaults)
        if seedPairing {
            let macKey = Base64.encode(Data(repeating: 9, count: 32))
            store.upsert(
                PairedHostRecord(
                    relayUrl: Self.unroutableRelay,
                    macIdentityPubKey: macKey,
                    macDisplayName: "Storm Host",
                    relayUrls: [Self.unroutableRelay],
                    hostPlatform: "mac",
                    pairedAt: "2026-07-28T19:49:00Z",
                    macAgreePub: nil))
            store.setSelectedHostId(macKey)
        }
        return RemoteSessionModel(
            identityStore: StaticIdentitySeedStore(),
            pairingStore: store)
    }

    private struct StaticIdentitySeedStore: IdentitySeedStore {
        func loadOrCreateSeed() throws -> Data {
            Data(repeating: 7, count: 32)
        }
    }
}
