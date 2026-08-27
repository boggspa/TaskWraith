import Foundation
import TaskWraithKit
import Testing

@testable import TaskWraithUI

@Suite("Host liveness paired-projection adapter")
struct HostLivenessProjectionAdapterTests {
    private let now = Date(timeIntervalSince1970: 1_000)

    private func health(
        status: HostHealthStatus = .ok,
        phase: HostConnectionPhase = .live,
        freshness: HostProjectionFreshness = .live
    ) -> HostHealthProjection {
        HostHealthProjection(
            hostStatus: status,
            connectionPhase: phase,
            supervised: true,
            freshness: freshness)
    }

    @Test("a live paired-host health projection makes live reachable")
    func liveProjectionIsLive() {
        #expect(
            HostLiveness.derive(
                sessionPhase: .connected,
                projectionPhase: .live,
                healthProjection: health(),
                probeLedger: HostLivenessProbeLedger(),
                now: now)
                == .live)
    }

    @Test("live transport with cached host fields is stale, not unreachable")
    func cachedProjectionIsStale() {
        #expect(
            HostLiveness.derive(
                sessionPhase: .connected,
                projectionPhase: .live,
                healthProjection: health(freshness: .cached),
                probeLedger: HostLivenessProbeLedger(),
                now: now)
                == .stale)
    }

    @Test("cached health without a live replica or socket observation cannot vouch for a route")
    func cachedBytesDoNotInventTransportHealth() {
        #expect(
            HostLiveness.derive(
                sessionPhase: .connected,
                projectionPhase: .unavailable,
                healthProjection: health(freshness: .cached),
                probeLedger: HostLivenessProbeLedger(),
                now: now)
                == .unreachable)
    }

    @Test("a silent peer over a recently healthy socket outranks live cached vocabulary")
    func realProbeAsymmetryIsAsleep() {
        var ledger = HostLivenessProbeLedger()
        ledger.record(alive: true, peer: false, at: now)
        ledger.record(alive: false, peer: true, at: now)

        #expect(
            HostLiveness.derive(
                sessionPhase: .connected,
                projectionPhase: .live,
                healthProjection: health(),
                probeLedger: ledger,
                now: now)
                == .asleep)
    }
}
