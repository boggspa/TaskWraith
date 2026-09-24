import Foundation
import TaskWraithKit
import Testing

@testable import TaskWraithUI

@Suite("HostLiveness derivation")
struct HostLivenessDerivationTests {

    // MARK: - No judgement while we are still trying

    @Test("idle / connecting / awaiting-confirm yield no judgement at all")
    func inProgressPhasesYieldNil() {
        for phase: SessionPhase in [.idle, .connecting, .awaitingMacConfirm(code: "482913")] {
            let derived = HostLiveness.derive(HostLivenessInputs(sessionPhase: phase))
            #expect(
                derived == nil,
                "\(phase) must not be projected as a liveness state — we have not finished trying"
            )
        }
    }

    @Test("an in-progress dial is never painted as unreachable, even with every negative signal")
    func connectingIsNeverUnreachable() {
        // The whole point of returning nil: a dial in progress with a dead
        // socket is NORMAL, and calling it "can't reach your Mac" is the lie.
        let derived = HostLiveness.derive(
            HostLivenessInputs(
                sessionPhase: .connecting,
                connectionPhase: .hostUnavailable,
                health: .offline,
                freshness: .stale,
                transportHealthy: false,
                peerAckFailing: true
            ))
        #expect(derived == nil)
    }

    @Test("a hard session error is unreachable")
    func sessionErrorIsUnreachable() {
        #expect(
            HostLiveness.derive(HostLivenessInputs(sessionPhase: .error("socket closed")))
                == .unreachable)
    }

    // MARK: - Precedence rules, one test per rule

    @Test("host-reported unavailable/offline/incompatible wins over healthy local signals")
    func hostReportedAbsenceWins() {
        for phase: HostConnectionPhase in [.hostUnavailable, .offline, .incompatibleProtocol] {
            let derived = HostLiveness.derive(
                HostLivenessInputs(
                    sessionPhase: .connected,
                    connectionPhase: phase,
                    health: .ok,
                    freshness: .live,
                    transportHealthy: true,
                    peerAckFailing: false
                ))
            #expect(derived == .unreachable, "\(phase) must project unreachable")
        }
    }

    @Test("transport down is unreachable — checked BEFORE the peer signal")
    func transportIsCheckedBeforePeer() {
        // A failed peer ack over a dead socket is evidence about the socket, not
        // the Mac. If this ordering regresses, every offline user is told their
        // Mac "isn't answering" when the real problem is their own network.
        let derived = HostLiveness.derive(
            HostLivenessInputs(
                sessionPhase: .connected,
                connectionPhase: .reconnecting,
                transportHealthy: false,
                peerAckFailing: true
            ))
        #expect(derived == .unreachable)
    }

    @Test("path healthy + peer silent is the asleep asymmetry")
    func peerSilenceOverHealthyPathIsAsleep() {
        let derived = HostLiveness.derive(
            HostLivenessInputs(
                sessionPhase: .connected,
                connectionPhase: .live,
                health: .ok,
                freshness: .live,
                transportHealthy: true,
                peerAckFailing: true
            ))
        #expect(derived == .asleep)
    }

    @Test("host health offline with a live path is unreachable, not asleep")
    func hostHealthOfflineIsUnreachable() {
        let derived = HostLiveness.derive(
            HostLivenessInputs(
                sessionPhase: .connected,
                connectionPhase: .live,
                health: .offline,
                freshness: .live,
                transportHealthy: true,
                peerAckFailing: false
            ))
        #expect(derived == .unreachable)
    }

    @Test("live is the NARROW case — any single non-fresh signal degrades to stale")
    func liveIsNarrow() {
        let allFresh = HostLivenessInputs(
            sessionPhase: .connected,
            connectionPhase: .live,
            health: .ok,
            freshness: .live,
            transportHealthy: true,
            peerAckFailing: false
        )
        #expect(HostLiveness.derive(allFresh) == .live)

        var agingPhase = allFresh
        agingPhase.connectionPhase = .staleCache
        #expect(HostLiveness.derive(agingPhase) == .stale)

        var agingPhase2 = allFresh
        agingPhase2.connectionPhase = .reconnecting
        #expect(HostLiveness.derive(agingPhase2) == .stale)

        var cached = allFresh
        cached.freshness = .cached
        #expect(HostLiveness.derive(cached) == .stale)

        var stale = allFresh
        stale.freshness = .stale
        #expect(HostLiveness.derive(stale) == .stale)

        for health: HostHealthStatus in [.degraded, .recovering] {
            var degraded = allFresh
            degraded.health = health
            #expect(HostLiveness.derive(degraded) == .stale, "\(health) must degrade to stale")
        }
    }

    @Test("absent evidence is NOT freshness — a bare connected session is stale, never live")
    func absentEvidenceNeverYieldsLive() {
        // REGRESSION GUARD. An earlier version of this file defaulted the three
        // optionals to their happy values (`?? .live` / `?? .ok`), so a
        // connected session with NO projection at all rendered as `.live` — and
        // the test that used to live here CODIFIED that. Missing evidence must
        // never become a positive claim; that is the entire point of the type.
        let derived = HostLiveness.derive(HostLivenessInputs(sessionPhase: .connected))
        #expect(derived == .stale)
    }

    @Test("live requires positive evidence on ALL THREE signals")
    func liveRequiresAllThreePresent() {
        let allFresh = HostLivenessInputs(
            sessionPhase: .connected,
            connectionPhase: .live,
            health: .ok,
            freshness: .live
        )
        #expect(HostLiveness.derive(allFresh) == .live)

        var noPhase = allFresh
        noPhase.connectionPhase = nil
        #expect(HostLiveness.derive(noPhase) == .stale, "absent phase must not qualify as live")

        var noFreshness = allFresh
        noFreshness.freshness = nil
        #expect(
            HostLiveness.derive(noFreshness) == .stale, "absent freshness must not qualify as live")

        var noHealth = allFresh
        noHealth.health = nil
        #expect(HostLiveness.derive(noHealth) == .stale, "absent health must not qualify as live")
    }

    // MARK: - Exhaustive sweep

    /// Walks the full input product and asserts the invariants that must hold
    /// for every combination. Deliberately asserts RULES rather than
    /// re-implementing the derivation — an oracle that mirrors the
    /// implementation would reproduce its bugs and prove nothing.
    @Test("exhaustive input sweep upholds every precedence invariant")
    func exhaustiveSweep() {
        let sessionPhases: [SessionPhase] = [
            .idle, .connecting, .awaitingMacConfirm(code: "000000"), .connected, .error("x"),
        ]
        let connectionPhases: [HostConnectionPhase?] =
            [nil] + HostConnectionPhase.allCases.map { Optional($0) }
        let healths: [HostHealthStatus?] = [nil] + HostHealthStatus.allCases.map { Optional($0) }
        let freshnesses: [HostProjectionFreshness?] =
            [nil] + HostProjectionFreshness.allCases.map { Optional($0) }
        let absentHostPhases: Set<HostConnectionPhase> = [
            .hostUnavailable, .offline, .incompatibleProtocol,
        ]

        var combinations = 0
        for sessionPhase in sessionPhases {
            for connectionPhase in connectionPhases {
                for health in healths {
                    for freshness in freshnesses {
                        for transportHealthy in [true, false] {
                            for peerAckFailing in [true, false] {
                                combinations += 1
                                let inputs = HostLivenessInputs(
                                    sessionPhase: sessionPhase,
                                    connectionPhase: connectionPhase,
                                    health: health,
                                    freshness: freshness,
                                    transportHealthy: transportHealthy,
                                    peerAckFailing: peerAckFailing
                                )
                                let derived = HostLiveness.derive(inputs)

                                switch sessionPhase {
                                case .idle, .connecting, .awaitingMacConfirm:
                                    #expect(derived == nil)
                                    continue
                                case .error:
                                    #expect(derived == .unreachable)
                                    continue
                                case .connected:
                                    break
                                }

                                // Connected always produces a judgement.
                                #expect(derived != nil)

                                if let connectionPhase, absentHostPhases.contains(connectionPhase) {
                                    #expect(derived == .unreachable)
                                } else if !transportHealthy {
                                    #expect(derived == .unreachable)
                                } else if peerAckFailing {
                                    #expect(derived == .asleep)
                                } else if health == .offline {
                                    #expect(derived == .unreachable)
                                } else {
                                    // Remaining space is exactly live | stale.
                                    #expect(derived == .live || derived == .stale)
                                    // And `.live` demands POSITIVE evidence on
                                    // all three. This invariant is what the
                                    // original `?? .live` defaults violated
                                    // across the whole nil-bearing half of the
                                    // input space.
                                    if derived == .live {
                                        #expect(connectionPhase == .live)
                                        #expect(freshness == .live)
                                        #expect(health == .ok)
                                    }
                                }

                                // Queue policy must stay coupled to the state.
                                if let derived {
                                    let expectQueue = derived == .asleep || derived == .unreachable
                                    #expect(derived.shouldQueueOutbound == expectQueue)
                                }
                            }
                        }
                    }
                }
            }
        }
        // Derived from the arrays rather than hard-coded, so adding a case to
        // any host enum widens the sweep instead of silently failing an
        // arithmetic literal nobody remembers how to recompute.
        let expected =
            sessionPhases.count * connectionPhases.count * healths.count * freshnesses.count * 2
            * 2
        #expect(combinations == expected)
        #expect(combinations >= 3_000, "sweep collapsed — an input array lost its cases")
    }

    @Test("derivation is deterministic")
    func derivationIsDeterministic() {
        let inputs = HostLivenessInputs(
            sessionPhase: .connected,
            connectionPhase: .staleCache,
            health: .degraded,
            freshness: .cached,
            transportHealthy: true,
            peerAckFailing: false
        )
        #expect(HostLiveness.derive(inputs) == HostLiveness.derive(inputs))
    }
}

@Suite("HostLivenessProbeLedger evidence rule (R1)")
struct HostLivenessProbeLedgerTests {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)
    private func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

    @Test("a peer failure ALONE is not evidence the path is healthy")
    func peerFailureAloneIsNotAsleep() {
        // The core of R1. A peer probe can fail precisely BECAUSE the socket
        // died; on its own it says nothing about the transport.
        var ledger = HostLivenessProbeLedger()
        ledger.record(alive: false, peer: true, at: t0)

        #expect(ledger.transportHealthy(at: t0) == false)
        #expect(ledger.peerAckFailing(at: t0) == false, "must not claim the asleep asymmetry")
    }

    @Test("peer failure over a freshly-alive socket IS the asleep asymmetry")
    func peerFailureOverLiveSocketIsAsleep() {
        var ledger = HostLivenessProbeLedger()
        ledger.record(alive: true, peer: false, at: t0)  // socket seen alive
        ledger.record(alive: false, peer: true, at: at(1))  // Mac silent

        #expect(ledger.transportHealthy(at: at(1)))
        #expect(ledger.peerAckFailing(at: at(1)))
    }

    @Test("a socket-down observation CLEARS a standing peer verdict")
    func socketDownClearsPeerVerdict() {
        // Otherwise a stale peer failure keeps vouching for an asymmetry that
        // no longer exists, and `.asleep` outlives its own evidence.
        var ledger = HostLivenessProbeLedger()
        ledger.record(alive: true, peer: false, at: t0)
        ledger.record(alive: false, peer: true, at: at(1))
        #expect(ledger.peerAckFailing(at: at(1)))

        ledger.record(alive: false, peer: false, at: at(2))
        #expect(ledger.peerProbeFailing == false, "the verdict is now unattributable")
        #expect(ledger.transportHealthy(at: at(2)) == false)
        #expect(ledger.peerAckFailing(at: at(2)) == false)
    }

    @Test("a stale socket observation cannot vouch for the path")
    func socketObservationExpires() {
        var ledger = HostLivenessProbeLedger()
        ledger.record(alive: true, peer: false, at: t0)
        ledger.record(alive: false, peer: true, at: at(1))

        // Inside the window: the asymmetry holds.
        #expect(ledger.peerAckFailing(at: at(29)))
        // Past it: we can no longer claim the path is up.
        #expect(ledger.transportHealthy(at: at(31)) == false)
        #expect(ledger.peerAckFailing(at: at(31)) == false)
    }

    @Test("reaching the peer proves the socket carried the ping")
    func peerSuccessImpliesSocketAlive() {
        var ledger = HostLivenessProbeLedger()
        ledger.record(alive: true, peer: true, at: t0)
        #expect(ledger.transportHealthy(at: t0))
        #expect(ledger.peerProbeFailing == false)
    }

    @Test("a peer success clears an earlier peer failure")
    func peerSuccessClearsFailure() {
        var ledger = HostLivenessProbeLedger()
        ledger.record(alive: true, peer: false, at: t0)
        ledger.record(alive: false, peer: true, at: at(1))
        #expect(ledger.peerAckFailing(at: at(1)))

        ledger.record(alive: true, peer: true, at: at(2))
        #expect(ledger.peerAckFailing(at: at(2)) == false)
    }

    @Test("a fresh ledger claims nothing")
    func emptyLedgerClaimsNothing() {
        let ledger = HostLivenessProbeLedger()
        #expect(ledger.transportHealthy(at: t0) == false)
        #expect(ledger.peerAckFailing(at: t0) == false)
    }

    @Test("reset forgets everything, so one host's evidence cannot describe another")
    func resetForgets() {
        var ledger = HostLivenessProbeLedger()
        ledger.record(alive: true, peer: false, at: t0)
        ledger.record(alive: false, peer: true, at: at(1))
        ledger.reset()

        #expect(ledger.lastSocketAliveAt == nil)
        #expect(ledger.peerProbeFailing == false)
        #expect(ledger.peerAckFailing(at: at(1)) == false)
    }

    // MARK: - End to end: ledger -> inputs -> derivation

    @Test("end to end, the ledger drives `.asleep` only with both halves present")
    func ledgerDrivesDerivation() {
        func derive(_ ledger: HostLivenessProbeLedger, at now: Date) -> HostLiveness? {
            HostLiveness.derive(
                HostLivenessInputs(
                    sessionPhase: .connected,
                    connectionPhase: .live,
                    health: .ok,
                    freshness: .live,
                    transportHealthy: ledger.transportHealthy(at: now),
                    peerAckFailing: ledger.peerAckFailing(at: now)
                ))
        }

        // Both halves -> asleep.
        var asleep = HostLivenessProbeLedger()
        asleep.record(alive: true, peer: false, at: t0)
        asleep.record(alive: false, peer: true, at: at(1))
        #expect(derive(asleep, at: at(1)) == .asleep)

        // Peer failure with no fresh socket evidence -> unreachable, NOT asleep.
        var noSocketEvidence = HostLivenessProbeLedger()
        noSocketEvidence.record(alive: false, peer: true, at: t0)
        #expect(derive(noSocketEvidence, at: t0) == .unreachable)

        // Everything healthy -> live.
        var healthy = HostLivenessProbeLedger()
        healthy.record(alive: true, peer: true, at: t0)
        #expect(derive(healthy, at: t0) == .live)
    }
}

@Suite("HostLiveness copy honesty")
struct HostLivenessCopyHonestyTests {

    /// The load-bearing test of this whole item.
    ///
    /// The phone cannot tell a sleeping Mac from a crashed one, a quit app, or a
    /// dead network stack. `asleep` is an internal evidence-shape name; the
    /// rendered copy must never assert the power state. If someone "tightens"
    /// the copy to "Your Mac is asleep", this test goes red and tells them why.
    @Test("asleep copy never asserts that the Mac is asleep")
    func asleepCopyDoesNotAssertSleep() {
        let copy = HostLiveness.asleep.copy
        let assertions = [
            "your mac is asleep", "mac is asleep", "is sleeping", "is asleep",
        ]
        let headline = copy.headline.lowercased()
        let detail = copy.detail.lowercased()
        for assertion in assertions {
            #expect(
                !headline.contains(assertion),
                "headline asserts a power state it cannot know: \(copy.headline)")
            #expect(
                !detail.contains(assertion),
                "detail asserts a power state it cannot know: \(copy.detail)")
        }
    }

    @Test("asleep detail hedges across the indistinguishable causes")
    func asleepCopyHedges() {
        let detail = HostLiveness.asleep.copy.detail.lowercased()
        // Hedged phrasing is required, not optional: the user needs to know that
        // relaunching the app is as plausible a fix as waking the machine.
        #expect(detail.contains("may"))
        #expect(detail.contains("asleep"))
        #expect(detail.contains("closed") || detail.contains("quit"))
    }

    @Test("every state has non-empty headline and detail")
    func everyStateHasCopy() {
        for state in HostLiveness.allCases {
            #expect(!state.copy.headline.isEmpty, "\(state) headline")
            #expect(!state.copy.detail.isEmpty, "\(state) detail")
        }
    }

    @Test("queue notice exists exactly for the states that queue, and promises only delivery")
    func queueNoticeMatchesQueuePolicy() {
        for state in HostLiveness.allCases {
            let notice = state.copy.queueNotice
            #expect(
                (notice != nil) == state.shouldQueueOutbound,
                "\(state) queueNotice presence must match shouldQueueOutbound")
            guard let notice else { continue }
            // Queuing promises the attempt survives, never that the work runs —
            // the Mac remains authoritative and may still reject it.
            let lowered = notice.lowercased()
            #expect(!lowered.contains("will run"))
            #expect(!lowered.contains("will start"))
            #expect(lowered.contains("send"))
        }
    }

    @Test("only live is banner-free")
    func bannerPolicy() {
        #expect(HostLiveness.live.warrantsBanner == false)
        for state in HostLiveness.allCases where state != .live {
            #expect(state.warrantsBanner, "\(state) must warrant a banner")
        }
    }

    @Test("stale does not divert sends — a cached view is not a broken send path")
    func staleDoesNotQueue() {
        #expect(HostLiveness.stale.shouldQueueOutbound == false)
        #expect(HostLiveness.live.shouldQueueOutbound == false)
    }
}
