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

/// Round 2 (2026-07-29, user-reported on device): the first fix collapsed a
/// BURST of wakes into one dial, but the dial itself could never finish while
/// the app stayed awake. Two independent defects, both arithmetic rather than
/// racy — which is why quitting and relaunching (one wake, no action traffic)
/// always "fixed" it and foregrounding never did.
@Suite("Reconnect storm — foreground-resume lane")
struct ReconnectStormForegroundTests {
    /// The supervisor must outlive the walk it supervises. With the old 15s
    /// default against a routine LAN+relay walk (5+5+12+12 = 34s), every wake
    /// past the 15s mark read a HEALTHY dial as timed out and superseded it —
    /// tearing the client down mid-establish and restarting from door one.
    @Test("a healthy walk is not superseded before its real budget expires")
    func healthyWalkSurvivesLateWakes() {
        let candidates = ["ws://192.168.0.147:8837", "wss://mac.tail2d0961.ts.net:8443"]
        let budget = Double(RelayCandidates.walkBudgetMs(for: candidates)) / 1000
        var coord = ReconnectCoordinator()
        let t0 = Date(timeIntervalSince1970: 1_700_000_000)

        #expect(
            coord.evaluate(reason: .health, phase: .connected, now: t0, socketAlive: false)
                == .start)
        coord.markAttemptStarted(at: t0, budgetSeconds: budget)

        // The exact shape that stormed: queued actions waking at 16s and 25s
        // while the walk is still working its way to the relay door.
        for seconds in [16.0, 20.0, 25.0, 30.0] {
            let now = t0.addingTimeInterval(seconds)
            #expect(
                coord.evaluate(
                    reason: .health, phase: .connecting, now: now, socketAlive: false) == .ignore,
                "a wake at \(seconds)s must coalesce into the in-flight walk")
        }

        // Past the REAL budget it is genuinely stuck, and superseding is right.
        let expired = t0.addingTimeInterval(budget + 1)
        #expect(
            coord.evaluate(reason: .health, phase: .connecting, now: expired, socketAlive: false)
                == .supersede)

        // Teeth: the SAME 16s wake against an unbudgeted supervisor is exactly
        // the bug — a healthy walk torn down and restarted from door one.
        var unbudgeted = ReconnectCoordinator()
        #expect(
            unbudgeted.evaluate(reason: .health, phase: .connected, now: t0, socketAlive: false)
                == .start)
        unbudgeted.markAttemptStarted(at: t0)
        #expect(
            unbudgeted.evaluate(
                reason: .health, phase: .connecting, now: t0.addingTimeInterval(16),
                socketAlive: false) == .supersede)
    }

    @Test("the walk budget covers every door's resolve and connect legs")
    func walkBudgetCoversBothLegsOfEveryDoor() {
        // Both legs are handed the SAME per-candidate budget, so a door costs
        // twice its dial timeout.
        let lan = "ws://192.168.0.147:8837"
        let relay = "wss://mac.tail2d0961.ts.net:8443"
        #expect(RelayCandidates.dialTimeoutMs(for: lan) == 5_000)
        #expect(RelayCandidates.dialTimeoutMs(for: relay) == 12_000)
        #expect(RelayCandidates.walkBudgetMs(for: [lan, relay]) == 5_000 * 2 + 12_000 * 2 + 3_000)
        // The whole point: it must exceed the supervisor's old fixed default.
        #expect(RelayCandidates.walkBudgetMs(for: [lan, relay]) > 15_000)
        #expect(RelayCandidates.walkBudgetMs(for: [relay]) > 15_000)
        #expect(RelayCandidates.walkBudgetMs(for: []) == 3_000)
    }

    @Test("markAttemptStarted without a budget leaves the timeout alone")
    func defaultBudgetIsUnchanged() {
        var coord = ReconnectCoordinator(connectTimeout: 15)
        coord.markAttemptStarted(at: Date(timeIntervalSince1970: 1_700_000_000))
        #expect(coord.connectTimeout == 15)
        coord.markAttemptStarted(
            at: Date(timeIntervalSince1970: 1_700_000_000), budgetSeconds: 0)
        #expect(coord.connectTimeout == 15)
    }

    /// The retry ladder must actually climb. Zeroing it on every dial meant
    /// the documented 1.5s→30s curve never left its first rung, so a failing
    /// reconnect re-dialled every 1.5s indefinitely — the visible "banner
    /// flapping" half of the report.
    @MainActor
    @Test("only an explicit user retry resets the backoff ladder")
    func backoffLadderSurvivesAutomaticRetries() async {
        let defaults = UserDefaults(suiteName: "ReconnectBackoff.\(UUID().uuidString)")!
        let store = UserDefaultsPairedHostStore(defaults: defaults)
        let macKey = Base64.encode(Data(repeating: 9, count: 32))
        store.upsert(
            PairedHostRecord(
                relayUrl: "ws://127.0.0.1:1/relay",
                macIdentityPubKey: macKey,
                macDisplayName: "Backoff Host",
                relayUrls: ["ws://127.0.0.1:1/relay"],
                hostPlatform: "mac",
                pairedAt: "2026-07-29T15:00:00Z",
                macAgreePub: nil))
        store.setSelectedHostId(macKey)
        let model = RemoteSessionModel(
            identityStore: BackoffSeedStore(), pairingStore: store)

        // The ladder is climbed by scheduleAutoReconnect after each failure;
        // the reset decision under test is synchronous inside requestReconnect.
        model.autoReconnectAttemptForTesting = 3
        model.requestReconnect(.resume)
        #expect(
            model.autoReconnectAttemptForTesting == 3,
            "an automatic retry must not drop back to the 1.5s rung")

        model.autoReconnectAttemptForTesting = 3
        model.requestReconnect(ReconnectWakeReason.user)
        #expect(model.autoReconnectAttemptForTesting == 0, "a user tap earns the fast ladder")

        try? await Task.sleep(nanoseconds: 20_000_000)
        model.forgetAllHosts()
    }

    private struct BackoffSeedStore: IdentitySeedStore {
        func loadOrCreateSeed() throws -> Data { Data(repeating: 7, count: 32) }
    }
}

/// Round 3 (2026-08-15, user-reported on device): opening the app from the home
/// screen behaves, but opening it from a notification / approval / Live Activity
/// storms. The difference is the wake SOURCE — `handleRemoteWake` is reached only
/// from the three notification entry points, and iOS delivers the queued silent
/// pushes back to back the moment the app wakes.
@Suite("Reconnect storm — APNs wake lane")
@MainActor
struct ReconnectStormApnsWakeTests {
    /// Public cleartext `ws://`, so the ATS preflight rejects it and the walk
    /// fails without touching the network — the "Mac unreachable" shape.
    private static let unroutableRelay = "ws://reconnect-storm-apns.invalid:9"

    /// A burst of queued pushes must not each buy a fresh relay-door walk.
    @Test("a burst of queued APNs wakes does not dial once per push")
    func apnsBurstDoesNotDialPerPush() async {
        let model = makePairedModel()

        // The wake that actually finds the Mac gone: one walk, then `.error`
        // with the 1.5s→30s backoff ladder armed.
        _ = await model.handleRemoteWake(reason: "remote-notification", timeoutMs: 0)
        await settle()
        let afterFirst = model.trustedReconnectDialsForTesting

        // iOS flushes the backlog: five more silent pushes in well under a
        // second, each landing while the ladder is still waiting on its
        // first rung.
        for _ in 0..<5 {
            _ = await model.handleRemoteWake(reason: "remote-notification", timeoutMs: 0)
            await settle()
        }

        #expect(
            model.trustedReconnectDialsForTesting == afterFirst,
            "each queued push bought its own relay-door walk instead of coalescing")
        model.forgetAllHosts()
    }

    /// The cooldown must never strand the user behind it: the Retry button is
    /// the one gesture that always earns a fresh walk.
    @Test("an explicit user retry still dials inside the cooldown")
    func userRetryBypassesCooldown() async {
        let model = makePairedModel()

        _ = await model.handleRemoteWake(reason: "remote-notification", timeoutMs: 0)
        await settle()
        let afterFirst = model.trustedReconnectDialsForTesting

        model.requestReconnect(.user)
        await settle()

        #expect(
            model.trustedReconnectDialsForTesting == afterFirst + 1,
            "a user tap must not be swallowed by the post-failure cooldown")
        model.forgetAllHosts()
    }

    /// The pure policy, stated directly: a wake landing in the cooldown after a
    /// FAILED attempt is dropped; the same wake past it is honoured.
    @Test("the coordinator drops non-user wakes inside the redial cooldown")
    func coordinatorHoldsTheRedialFloor() {
        var coord = ReconnectCoordinator()
        let t0 = Date(timeIntervalSince1970: 1_700_000_000)

        #expect(coord.evaluate(reason: .apns, phase: .error("x"), now: t0) == .start)
        coord.markAttemptStarted(at: t0)
        coord.markAttemptFailed(at: t0.addingTimeInterval(0.2))

        // The push backlog lands in the next few hundred milliseconds.
        for offset in [0.25, 0.4, 0.9, 1.6] {
            #expect(
                coord.evaluate(
                    reason: .apns, phase: .error("x"), now: t0.addingTimeInterval(offset))
                    == .ignore,
                "a push at \(offset)s must defer to the armed retry ladder")
        }

        // Past the floor it is genuine new evidence the Mac may be back.
        #expect(
            coord.evaluate(reason: .apns, phase: .error("x"), now: t0.addingTimeInterval(2.0))
                == .start)
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    /// Let the (network-free) walk fail and settle back to `.error`.
    private func settle() async {
        try? await Task.sleep(nanoseconds: 30_000_000)
    }

    private func makePairedModel() -> RemoteSessionModel {
        let defaults = UserDefaults(suiteName: "ReconnectStormApns.\(UUID().uuidString)")!
        let store = UserDefaultsPairedHostStore(defaults: defaults)
        let macKey = Base64.encode(Data(repeating: 9, count: 32))
        store.upsert(
            PairedHostRecord(
                relayUrl: Self.unroutableRelay,
                macIdentityPubKey: macKey,
                macDisplayName: "Storm Host",
                relayUrls: [Self.unroutableRelay],
                hostPlatform: "mac",
                pairedAt: "2026-08-15T00:00:00Z",
                macAgreePub: nil))
        store.setSelectedHostId(macKey)
        return RemoteSessionModel(
            identityStore: ApnsSeedStore(), pairingStore: store)
    }

    private struct ApnsSeedStore: IdentitySeedStore {
        func loadOrCreateSeed() throws -> Data { Data(repeating: 7, count: 32) }
    }
}
