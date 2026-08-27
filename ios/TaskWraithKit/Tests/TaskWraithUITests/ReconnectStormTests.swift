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

/// Round 4 (2026-08-27): notification-tap / silent APNs / widget cold-start
/// plus the scenePhase `.active` foreground probe can land `.health` with
/// `socketAlive: false` on a session that established milliseconds ago.
/// The coordinator's half-open path used to supersede that session; the
/// post-establish grace + shared health probe close the remaining storm.
@Suite("Reconnect storm — post-establish grace")
@MainActor
struct ReconnectStormPostEstablishTests {
    private static let unroutableRelay = "ws://reconnect-storm-grace.invalid:9"

    @Test("notification-tap + scenePhase.active does not redial a just-established session")
    func notificationTapAndForegroundDoNotRedialFreshSession() async {
        let model = makePairedModel()
        model.markJustEstablishedForTesting()
        #expect(model.trustedReconnectDialsForTesting == 0)

        // Exact race: AppDelegate/notification tap calls handleRemoteWake
        // while RootView.onChange(scenePhase -> .active) calls reconnectIfStale
        // → requestReconnect(.foreground) → verifyConnectedSocket. With no live
        // client both land as `.health` + socketAlive:false from `.connected`.
        async let wake: Bool = model.handleRemoteWake(
            reason: "notification-tap", timeoutMs: 0)
        model.reconnectIfStale()
        _ = await wake

        #expect(
            model.trustedReconnectDialsForTesting == 0,
            "a racy health-false against a just-established session started a new dial")
        if case .connected = model.phase {
            // expected
        } else {
            Issue.record("phase became \(String(describing: model.phase)) instead of staying connected")
        }
        model.forgetAllHosts()
    }

    @Test("an explicit health-false after grace still redials")
    func healthFalseAfterGraceStillRedials() {
        let model = makePairedModel()
        let establishedAt = Date(timeIntervalSince1970: 1_700_000_000)
        model.markJustEstablishedForTesting(at: establishedAt)
        // Drive the coordinator clock past the grace via a direct evaluate-equivalent
        // wake: requestReconnect uses Date(), so stamp establish in the past.
        model.markJustEstablishedForTesting(
            at: Date().addingTimeInterval(-(ReconnectCoordinator.defaultPostEstablishGrace + 0.1)))
        model.requestReconnect(.health, socketAlive: false)
        #expect(
            model.trustedReconnectDialsForTesting == 1,
            "a genuine half-open past the grace window must still start a dial")
        model.forgetAllHosts()
    }

    @Test("overlapping wake and foreground probes share one health flight")
    func overlappingWakeAndForegroundShareOneHealthFlight() async {
        let model = makePairedModel()
        model.markJustEstablishedForTesting()
        model.healthProbeOverrideForTesting = {
            try? await Task.sleep(nanoseconds: 80_000_000)
            return true
        }

        async let wake: Bool = model.handleRemoteWake(
            reason: "notification-tap", timeoutMs: 500)
        // Yield so the wake starts the hanging probe, then the scenePhase
        // `.active` path must JOIN it rather than start a second ping.
        try? await Task.sleep(nanoseconds: 15_000_000)
        model.reconnectIfStale()
        _ = await wake

        #expect(
            model.socketHealthProbeStartsForTesting == 1,
            "handleRemoteWake and verifyConnectedSocket stacked independent probes")
        #expect(model.trustedReconnectDialsForTesting == 0)
        model.forgetAllHosts()
    }

    private func makePairedModel() -> RemoteSessionModel {
        let defaults = UserDefaults(suiteName: "ReconnectStormGrace.\(UUID().uuidString)")!
        let store = UserDefaultsPairedHostStore(defaults: defaults)
        let macKey = Base64.encode(Data(repeating: 9, count: 32))
        store.upsert(
            PairedHostRecord(
                relayUrl: Self.unroutableRelay,
                macIdentityPubKey: macKey,
                macDisplayName: "Storm Host",
                relayUrls: [Self.unroutableRelay],
                hostPlatform: "mac",
                pairedAt: "2026-08-27T00:00:00Z",
                macAgreePub: nil))
        store.setSelectedHostId(macKey)
        return RemoteSessionModel(
            identityStore: GraceSeedStore(), pairingStore: store)
    }

    private struct GraceSeedStore: IdentitySeedStore {
        func loadOrCreateSeed() throws -> Data { Data(repeating: 7, count: 32) }
    }
}

/// Round 5 (2026-08-27): explicit disconnect / demo / host-switch must invalidate
/// an in-flight trusted walk and the 1.2s `handleSocketClosed` redial, and the
/// lock-screen approval path must fit the ~30s iOS background window.
@Suite("Reconnect lifecycle invalidation")
@MainActor
struct ReconnectLifecycleInvalidationTests {
    private static let unroutableRelay = "ws://reconnect-lifecycle.invalid:9"

    @Test("a walk resolving after disconnect does not resurrect the session")
    func walkAfterDisconnectDoesNotResurrect() async {
        let model = makePairedModel()
        model.requestReconnect(.user)
        #expect(model.trustedReconnectDialsForTesting == 1)
        #expect(model.reconnectCoordinatorInFlightForTesting)

        model.disconnect()
        #expect(model.phase == .idle)

        // The ATS-rejected walk finishes in the next turn and used to overwrite
        // `.idle` with `.error` then arm `scheduleAutoReconnect`.
        try? await Task.sleep(nanoseconds: 80_000_000)

        #expect(
            model.phase == .idle,
            "in-flight walk resurrected phase to \(String(describing: model.phase)) after disconnect")
        #expect(
            !model.reconnectCoordinatorInFlightForTesting,
            "disconnect left the coordinator in-flight so a later wake could supersede")
        #expect(
            model.trustedReconnectDialsForTesting == 1,
            "a late walk or auto-retry started another dial after disconnect")
        model.forgetAllHosts()
    }

    @Test("enterDemo during an in-flight walk stays on the demo session")
    func enterDemoDuringWalkDoesNotResurrect() async {
        let model = makePairedModel()
        model.requestReconnect(.user)
        model.enterDemoMode()
        #expect(model.isDemo)
        if case .connected = model.phase {
            // expected
        } else {
            Issue.record("demo phase was \(String(describing: model.phase)) instead of .connected")
        }

        try? await Task.sleep(nanoseconds: 80_000_000)

        #expect(model.isDemo, "late walk cleared the demo flag")
        if case .connected = model.phase {
            // expected
        } else {
            Issue.record(
                "late walk resurrected demo phase to \(String(describing: model.phase))")
        }
        #expect(model.trustedReconnectDialsForTesting == 1)
        model.forgetAllHosts()
    }

    @Test("disconnect during the delayed socket-closed redial does not redial")
    func disconnectCancelsDelayedSocketClosedRedial() async {
        let model = makePairedModel()
        model.markJustEstablishedForTesting()
        model.socketClosedRedialDelayMsForTesting = 40
        model.simulateUnexpectedSocketCloseForTesting()
        #expect(model.trustedReconnectDialsForTesting == 0)

        model.disconnect()
        #expect(model.phase == .idle)

        try? await Task.sleep(nanoseconds: 120_000_000)

        #expect(
            model.trustedReconnectDialsForTesting == 0,
            "the 1.2s delayed redial started a walk after explicit disconnect")
        #expect(model.phase == .idle)
        model.forgetAllHosts()
    }

    @Test("the legacy wake + peer + ack stack exceeds the background budget")
    func legacyApprovalStackExceedsBackgroundBudget() {
        let stacked =
            22_000
            + RemoteSessionModel.notificationApprovalPeerPreflightMs
            + RemoteSessionModel.notificationApprovalDefaultAckTimeoutMs
        #expect(stacked > RemoteSessionModel.notificationApprovalBackgroundBudgetMs)
    }

    @Test("remaining ack timeout never lets wake + peer + ack exceed the budget")
    func remainingAckTimeoutFitsBackgroundBudget() {
        let budget = RemoteSessionModel.notificationApprovalBackgroundBudgetMs

        let afterLongWake = RemoteSessionModel.remainingNotificationApprovalAckTimeoutMs(
            elapsedMs: 22_000)
        if let afterLongWake {
            #expect(
                22_000 + afterLongWake <= budget,
                "full 7s ack after a 22s wake overflows the \(budget)ms budget")
        }

        let afterWakeAndPeer = RemoteSessionModel.remainingNotificationApprovalAckTimeoutMs(
            elapsedMs: 22_000,
            peerPreflightMs: RemoteSessionModel.notificationApprovalPeerPreflightMs)
        if let afterWakeAndPeer {
            #expect(
                22_000 + RemoteSessionModel.notificationApprovalPeerPreflightMs + afterWakeAndPeer
                    <= budget,
                "wake + 6s peer + ack overflows the background budget")
        } else {
            // aborting is also a valid fit
        }

        #expect(
            RemoteSessionModel.remainingNotificationApprovalAckTimeoutMs(elapsedMs: 27_500) == nil,
            "a nearly exhausted budget must abort rather than start a 7s ack")
    }

    private func makePairedModel() -> RemoteSessionModel {
        let defaults = UserDefaults(suiteName: "ReconnectLifecycle.\(UUID().uuidString)")!
        let store = UserDefaultsPairedHostStore(defaults: defaults)
        let macKey = Base64.encode(Data(repeating: 9, count: 32))
        store.upsert(
            PairedHostRecord(
                relayUrl: Self.unroutableRelay,
                macIdentityPubKey: macKey,
                macDisplayName: "Storm Host",
                relayUrls: [Self.unroutableRelay],
                hostPlatform: "mac",
                pairedAt: "2026-08-27T00:00:00Z",
                macAgreePub: nil))
        store.setSelectedHostId(macKey)
        return RemoteSessionModel(
            identityStore: LifecycleSeedStore(), pairingStore: store)
    }

    private struct LifecycleSeedStore: IdentitySeedStore {
        func loadOrCreateSeed() throws -> Data { Data(repeating: 7, count: 32) }
    }
}

/// S3 (2026-08-27): cold-launch cached recovery + notification deep-link ordering.
/// A stored pairing must keep ConnectedShell mounted on the next launch, a wake
/// establish must rehydrate, and the tap target must be registered before the
/// reconnect walk so `.established` can consume it.
@Suite("Cached recovery + notification entry")
@MainActor
struct ReconnectCachedRecoveryTests {
    private static let unroutableRelay = "ws://reconnect-cached.invalid:9"

    @Test("a stored pairing restores wasEverConnected on cold launch")
    func storedPairingRestoresWasEverConnected() {
        let model = makePairedModel()
        #expect(
            model.wasEverConnected,
            "cold launch with a persisted pairing left wasEverConnected=false, so PairingView mounts")
        #expect(
            SessionShellPolicy.showShellDuringDrop(
                wasEverConnected: model.wasEverConnected,
                hasStoredPairing: model.hasStoredPairing,
                phase: .idle),
            "RootView would flash PairingView on a paired cold launch")
        model.forgetAllHosts()
    }

    @Test("forgetting every host clears wasEverConnected for the next launch")
    func forgetAllHostsClearsWasEverConnectedAcrossLaunches() {
        let suite = "ReconnectCachedForget.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let store = seedPairing(defaults: defaults)
        let model = RemoteSessionModel(
            identityStore: CachedSeedStore(), pairingStore: store, pushGatewayDefaults: defaults)
        model.applySessionEstablishedForTesting()
        #expect(model.wasEverConnected)
        model.forgetAllHosts()

        let relaunch = RemoteSessionModel(
            identityStore: CachedSeedStore(), pairingStore: store, pushGatewayDefaults: defaults)
        #expect(!relaunch.hasStoredPairing)
        #expect(
            !relaunch.wasEverConnected,
            "forgetAllHosts left wasEverConnected set so a later unpaired launch would still hold the shell")
        #expect(
            !SessionShellPolicy.showShellDuringDrop(
                wasEverConnected: relaunch.wasEverConnected,
                hasStoredPairing: relaunch.hasStoredPairing,
                phase: .idle))
        defaults.removePersistentDomain(forName: suite)
    }

    @Test("notification tap registers the deep-link target before the wake walk")
    func notificationTapRegistersDeepLinkBeforeWake() async {
        let model = makePairedModel()
        model.setPhaseForTesting(.idle)
        var pendingAtWakeStart: String?
        model.remoteWakeBeganHookForTesting = {
            pendingAtWakeStart = model.pendingDeepLinkThreadIdForTesting
        }

        await model.performNotificationTapForTesting(threadId: "thread-notif")

        #expect(
            pendingAtWakeStart == "thread-notif",
            "handleNotificationTap registered the target after handleRemoteWake, so .established during the walk missed it")
        model.forgetAllHosts()
    }

    @Test("an .established from a notification wake rehydrates the projection")
    func establishedFromWakeRehydrates() async {
        let model = makePairedModel()
        model.setPhaseForTesting(.idle)
        _ = await model.handleRemoteWake(reason: "notification-tap", timeoutMs: 0)
        #expect(model.aliveRehydrateInvocationsForTesting == 0)

        model.applySessionEstablishedForTesting()
        #expect(
            model.aliveRehydrateInvocationsForTesting == 1,
            ".established from a wake did not call rehydrateAfterAliveWake — home list stays stale")
        model.forgetAllHosts()
    }

    @Test("silent push and approval wakes do not arm wake rehydrate")
    func silentAndApprovalWakesDoNotArmRehydrate() async {
        let model = makePairedModel()
        model.setPhaseForTesting(.idle)
        _ = await model.handleRemoteWake(
            reason: RemoteSessionModel.silentPushWakeReason, timeoutMs: 0)
        model.applySessionEstablishedForTesting()
        #expect(
            model.aliveRehydrateInvocationsForTesting == 0,
            "silent-push establish spent the background budget on a projection resync")

        model.setPhaseForTesting(.idle)
        _ = await model.handleRemoteWake(
            reason: RemoteSessionModel.approvalAckWakeReason, timeoutMs: 0)
        model.applySessionEstablishedForTesting()
        #expect(
            model.aliveRehydrateInvocationsForTesting == 0,
            "approval-ack establish spent the background budget on a projection resync")
        model.forgetAllHosts()
    }

    @Test("shell policy holds ConnectedShell on idle/error only after a real pairing")
    func shellPolicyHoldsOnlyAfterPairing() {
        #expect(
            SessionShellPolicy.showShellDuringDrop(
                wasEverConnected: true, hasStoredPairing: true, phase: .idle))
        #expect(
            SessionShellPolicy.showShellDuringDrop(
                wasEverConnected: true, hasStoredPairing: true, phase: .connecting))
        #expect(
            !SessionShellPolicy.showShellDuringDrop(
                wasEverConnected: false, hasStoredPairing: true, phase: .idle),
            "first pairing must still get PairingView")
        #expect(
            !SessionShellPolicy.showShellDuringDrop(
                wasEverConnected: true, hasStoredPairing: false, phase: .idle))
        #expect(
            !SessionShellPolicy.showShellDuringDrop(
                wasEverConnected: true, hasStoredPairing: true, phase: .connected))
    }

    private func makePairedModel() -> RemoteSessionModel {
        let defaults = UserDefaults(suiteName: "ReconnectCached.\(UUID().uuidString)")!
        let store = seedPairing(defaults: defaults)
        return RemoteSessionModel(
            identityStore: CachedSeedStore(), pairingStore: store, pushGatewayDefaults: defaults)
    }

    private func seedPairing(defaults: UserDefaults) -> UserDefaultsPairedHostStore {
        let store = UserDefaultsPairedHostStore(defaults: defaults)
        let macKey = Base64.encode(Data(repeating: 9, count: 32))
        store.upsert(
            PairedHostRecord(
                relayUrl: Self.unroutableRelay,
                macIdentityPubKey: macKey,
                macDisplayName: "Cached Host",
                relayUrls: [Self.unroutableRelay],
                hostPlatform: "mac",
                pairedAt: "2026-08-27T00:00:00Z",
                macAgreePub: nil))
        store.setSelectedHostId(macKey)
        return store
    }

    private struct CachedSeedStore: IdentitySeedStore {
        func loadOrCreateSeed() throws -> Data { Data(repeating: 7, count: 32) }
    }
}
