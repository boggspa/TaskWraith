import Foundation
import Testing

@testable import TaskWraithUI

@Suite("ReconnectCoordinator single-flight")
struct ReconnectCoordinatorTests {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    @Test("idle/error wakes start a connect attempt")
    func startFromIdleOrError() {
        var coord = ReconnectCoordinator()
        #expect(coord.evaluate(reason: .resume, phase: .idle, now: t0) == .start)
        #expect(coord.inFlight)

        var coord2 = ReconnectCoordinator()
        #expect(coord2.evaluate(reason: .path, phase: .error("lost"), now: t0) == .start)
    }

    @Test("stacked APNs+foreground+path while connecting coalesce to one ignore")
    func coalesceMultiWakeStorm() {
        var coord = ReconnectCoordinator()
        #expect(coord.evaluate(reason: .apns, phase: .idle, now: t0) == .start)
        coord.markAttemptStarted(at: t0)

        let t1 = t0.addingTimeInterval(0.05)
        let t2 = t0.addingTimeInterval(0.1)
        let t3 = t0.addingTimeInterval(0.15)

        #expect(coord.evaluate(reason: .apns, phase: .connecting, now: t1) == .ignore)
        #expect(coord.evaluate(reason: .foreground, phase: .connecting, now: t2) == .ignore)
        #expect(coord.evaluate(reason: .path, phase: .connecting, now: t3) == .ignore)

        #expect(coord.pendingReasons.contains(.apns))
        #expect(coord.pendingReasons.contains(.foreground))
        #expect(coord.pendingReasons.contains(.path))
        #expect(coord.inFlight)
    }

    @Test("never supersede on connecting && !alive")
    func neverSupersedeConnectingNotAlive() {
        var coord = ReconnectCoordinator(inFlight: true, attemptStartedAt: t0)
        // Health / path probes that report !alive during dial must coalesce.
        #expect(
            coord.evaluate(
                reason: .health,
                phase: .connecting,
                now: t0.addingTimeInterval(1),
                socketAlive: false
            ) == .ignore)
        #expect(
            coord.evaluate(
                reason: .path,
                phase: .connecting,
                now: t0.addingTimeInterval(1.1),
                socketAlive: false
            ) == .ignore)
        #expect(
            coord.evaluate(
                reason: .apns,
                phase: .awaitingMacConfirm(code: "ABCD"),
                now: t0.addingTimeInterval(1.2),
                socketAlive: false
            ) == .ignore)
    }

    @Test("supersede on connect timeout")
    func supersedeOnTimeout() {
        var coord = ReconnectCoordinator(
            inFlight: true,
            attemptStartedAt: t0,
            connectTimeout: 15)
        let timedOut = t0.addingTimeInterval(15.1)
        #expect(
            coord.evaluate(reason: .path, phase: .connecting, now: timedOut) == .supersede)
        #expect(coord.pendingReasons.contains(.timeout))
    }

    @Test("explicit timeout reason supersedes in-flight dial")
    func explicitTimeoutReason() {
        var coord = ReconnectCoordinator(inFlight: true, attemptStartedAt: t0)
        #expect(
            coord.evaluate(reason: .timeout, phase: .connecting, now: t0.addingTimeInterval(1))
                == .supersede)
    }

    @Test("half-open from connected supersedes / starts")
    func halfOpenFromConnected() {
        var coord = ReconnectCoordinator()
        #expect(
            coord.evaluate(
                reason: .health,
                phase: .connected,
                now: t0,
                socketAlive: false
            ) == .start)

        var inFlight = ReconnectCoordinator(inFlight: true, attemptStartedAt: t0)
        // Unusual but legal: health fail while still bookkeeping inFlight.
        #expect(
            inFlight.evaluate(
                reason: .health,
                phase: .connected,
                now: t0,
                socketAlive: false
            ) == .supersede)
    }

    @Test("alive health probe from connected is ignored")
    func aliveHealthIgnored() {
        var coord = ReconnectCoordinator()
        #expect(
            coord.evaluate(
                reason: .health,
                phase: .connected,
                now: t0,
                socketAlive: true
            ) == .ignore)
    }

    @Test("foreground/apns/path on connected request health probe")
    func connectedWakesProbeHealth() {
        var coord = ReconnectCoordinator()
        #expect(coord.evaluate(reason: .foreground, phase: .connected, now: t0) == .probeHealth)
        #expect(coord.evaluate(reason: .apns, phase: .connected, now: t0) == .probeHealth)
        #expect(coord.evaluate(reason: .path, phase: .connected, now: t0) == .probeHealth)
    }

    @Test("user / generation bump supersedes in-flight")
    func generationBumpSupersedes() {
        var coord = ReconnectCoordinator(
            generation: 1,
            inFlight: true,
            attemptStartedAt: t0)
        #expect(coord.evaluate(reason: .user, phase: .connecting, now: t0) == .supersede)

        var coord2 = ReconnectCoordinator(
            generation: 1,
            inFlight: true,
            attemptStartedAt: t0)
        #expect(
            coord2.evaluate(
                reason: .path,
                phase: .connecting,
                now: t0,
                observedGeneration: 2
            ) == .supersede)
        #expect(coord2.generation == 2)
    }

    @Test("resumeIfIdle still starts from idle")
    func resumeFromIdle() {
        var coord = ReconnectCoordinator()
        #expect(coord.evaluate(reason: .resume, phase: .idle, now: t0) == .start)
        // Already connecting — coalesce, do not thrash.
        #expect(coord.evaluate(reason: .resume, phase: .connecting, now: t0) == .ignore)
    }

    @Test("markAttemptFinished clears flight and pending reasons")
    func markFinishedClearsState() {
        var coord = ReconnectCoordinator()
        _ = coord.evaluate(reason: .apns, phase: .idle, now: t0)
        coord.pendingReasons.insert(.foreground)
        coord.markAttemptFinished()
        #expect(!coord.inFlight)
        #expect(coord.attemptStartedAt == nil)
        #expect(coord.pendingReasons.isEmpty)
    }

    @Test("thrash matrix: three wakes in 200ms yield one start")
    func thrashMatrixOneAttempt() {
        var coord = ReconnectCoordinator()
        var starts = 0
        var ignores = 0

        for (i, reason) in [ReconnectWakeReason.apns, .foreground, .path].enumerated() {
            let now = t0.addingTimeInterval(Double(i) * 0.07)
            let phase: SessionPhase = starts == 0 ? .idle : .connecting
            switch coord.evaluate(reason: reason, phase: phase, now: now) {
            case .start, .supersede:
                starts += 1
                coord.markAttemptStarted(at: now)
            case .ignore:
                ignores += 1
            case .probeHealth:
                Issue.record("unexpected probeHealth during dial storm")
            }
        }

        #expect(starts == 1)
        #expect(ignores == 2)
    }
}
