import Foundation

/// Why a reconnect wake was requested. Recorded for diagnostics and coalesce.
public enum ReconnectWakeReason: String, Sendable, Equatable, Hashable, CaseIterable {
    case apns
    case foreground
    case path
    case health
    case timeout
    case user
    case resume
}

/// Pure policy outcome for a single reconnect wake.
public enum ReconnectAction: String, Sendable, Equatable {
    /// Begin a new connect attempt.
    case start
    /// Coalesce into the in-flight attempt; do nothing.
    case ignore
    /// Cancel the in-flight attempt and start a new one.
    case supersede
    /// Phase is `.connected` — run a health probe; do not dial yet.
    case probeHealth
}

/// Single-flight reconnect coordinator (pure decision table).
///
/// Coalesces competing APNs / foreground / path wakes into one connectAttempt.
/// Supersedes only on connect timeout, half-open-from-connected, or an explicit
/// generation bump (`.user`). Never supersedes on `connecting && !alive` —
/// during dial, a dead socket probe is the normal state and restarting it flaps.
///
/// Single-flight alone is NOT enough. It collapses wakes that OVERLAP a running
/// dial; it says nothing about wakes that arrive one after another once a dial
/// has already failed. Every wake source that fires once per app-open (the
/// scenePhase `.foreground` wake) is invisible to that gap — but APNs fires once
/// per queued push, and iOS flushes the whole backlog the instant the app wakes.
/// Against an unreachable Mac each walk fails in milliseconds (a LAN-only door
/// off-network is rejected by the ATS preflight without a socket), so six queued
/// pushes bought six full relay-door walks. `redialCooldown` is the missing
/// half: a floor between a FAILED attempt and the next non-user wake.
public struct ReconnectCoordinator: Sendable, Equatable {
    /// Matches the auto-retry ladder's first rung (`scheduleAutoReconnect`,
    /// 1.5s). A wake inside the window defers to the ladder that the failed
    /// attempt already armed, instead of preempting it — which is what kept the
    /// documented 1.5s→30s curve from ever being reached: `reconnectTrusted()`
    /// opens with `cancelAutoReconnect`, so every push cancelled the pending
    /// retry and dialled immediately in its place.
    public static let defaultRedialCooldown: TimeInterval = 1.5
    /// Covers a racy WebSocket ping (default 2.5s timeout) that lands false
    /// against a socket that just became `.established`. Notification-tap +
    /// scenePhase `.active` both probe in that window; treating a false ping
    /// as half-open tore the fresh session down and restarted the storm.
    public static let defaultPostEstablishGrace: TimeInterval = 3.0

    public var generation: Int
    public var inFlight: Bool
    public var attemptStartedAt: Date?
    public var pendingReasons: Set<ReconnectWakeReason>
    public var connectTimeout: TimeInterval
    /// When the last attempt FAILED. nil after a success — a healthy connect
    /// must never leave a cooldown behind for the next genuine wake.
    public var lastAttemptFailedAt: Date?
    public var redialCooldown: TimeInterval
    /// When the last attempt reached `.connected`. nil after a failure or
    /// before the first success. Drives `defaultPostEstablishGrace`.
    public var lastEstablishedAt: Date?
    public var postEstablishGrace: TimeInterval

    public init(
        generation: Int = 0,
        inFlight: Bool = false,
        attemptStartedAt: Date? = nil,
        pendingReasons: Set<ReconnectWakeReason> = [],
        connectTimeout: TimeInterval = 15,
        lastAttemptFailedAt: Date? = nil,
        redialCooldown: TimeInterval = ReconnectCoordinator.defaultRedialCooldown,
        lastEstablishedAt: Date? = nil,
        postEstablishGrace: TimeInterval = ReconnectCoordinator.defaultPostEstablishGrace
    ) {
        self.generation = generation
        self.inFlight = inFlight
        self.attemptStartedAt = attemptStartedAt
        self.pendingReasons = pendingReasons
        self.connectTimeout = connectTimeout
        self.lastAttemptFailedAt = lastAttemptFailedAt
        self.redialCooldown = redialCooldown
        self.lastEstablishedAt = lastEstablishedAt
        self.postEstablishGrace = postEstablishGrace
    }

    /// Evaluate a wake against the current session phase and flight state.
    ///
    /// - Parameters:
    ///   - reason: wake source
    ///   - phase: current `SessionPhase`
    ///   - now: clock (injectable for tests)
    ///   - socketAlive: only meaningful for `.health` from `.connected`
    ///   - observedGeneration: when set and greater than `generation`, treat as `.user` bump
    public mutating func evaluate(
        reason: ReconnectWakeReason,
        phase: SessionPhase,
        now: Date = Date(),
        socketAlive: Bool? = nil,
        observedGeneration: Int? = nil
    ) -> ReconnectAction {
        if let observed = observedGeneration, observed > generation {
            generation = observed
            return beginOrSupersede(reason: .user, now: now)
        }

        if reason == .user {
            return beginOrSupersede(reason: .user, now: now)
        }

        if reason == .timeout {
            guard inFlight || isConnectingPhase(phase) else { return .ignore }
            return beginOrSupersede(reason: .timeout, now: now)
        }

        if shouldTreatAsTimedOut(now: now) {
            return beginOrSupersede(reason: .timeout, now: now)
        }

        switch phase {
        case .connecting, .awaitingMacConfirm:
            // Coalesce only. Never restart just because a probe says !alive.
            pendingReasons.insert(reason)
            if !inFlight {
                // Phase already connecting — treat as in-flight for bookkeeping.
                inFlight = true
                if attemptStartedAt == nil { attemptStartedAt = now }
            }
            return .ignore

        case .connected:
            switch reason {
            case .health:
                if socketAlive == false {
                    // A WebSocket ping that fires in the same beat as
                    // `.established` (notification-tap + scenePhase `.active`)
                    // routinely returns false on a brand-new socket. Treating
                    // that as half-open superseded the session we just built.
                    if isInPostEstablishGrace(now: now) {
                        pendingReasons.insert(reason)
                        return .ignore
                    }
                    return beginOrSupersede(reason: .health, now: now)
                }
                return .ignore
            case .apns, .foreground, .path:
                pendingReasons.insert(reason)
                return .probeHealth
            case .resume, .timeout, .user:
                return .ignore
            }

        case .idle, .error:
            // The redial floor. `.user` and `.timeout` already returned above;
            // `.resume` is exempt because its only two callers are self-paced
            // (launch-time `resumeIfIdle`, and the auto-retry ladder's own
            // timer — whose first rung IS this interval, so gating it here
            // would race the boundary and could silence the ladder entirely).
            if reason != .resume, isInRedialCooldown(now: now) {
                pendingReasons.insert(reason)
                return .ignore
            }
            return beginOrSupersede(reason: reason, now: now)
        }
    }

    /// Caller invokes after acting on `.start` / `.supersede`.
    ///
    /// `budgetSeconds` is the attempt's REAL worst-case duration (a trusted
    /// reconnect walks every relay door, so it is far longer than a single
    /// dial). Passing it is what keeps `shouldTreatAsTimedOut` from killing a
    /// walk that is still working: with the default 15s against a 34s walk,
    /// every wake arriving after 15s superseded a healthy dial and restarted
    /// it from the first door — a reconnect that could never finish while the
    /// app was awake and issuing actions. nil keeps the current timeout.
    public mutating func markAttemptStarted(
        at now: Date = Date(),
        budgetSeconds: TimeInterval? = nil
    ) {
        inFlight = true
        attemptStartedAt = now
        if let budgetSeconds, budgetSeconds > 0 { connectTimeout = budgetSeconds }
    }

    /// Caller invokes when the attempt reaches `.connected`. Clears any cooldown:
    /// we are connected, so the next genuine wake must not be held behind a floor
    /// left over from an earlier failure.
    public mutating func markAttemptFinished(at now: Date = Date()) {
        inFlight = false
        attemptStartedAt = nil
        lastAttemptFailedAt = nil
        lastEstablishedAt = now
        pendingReasons.removeAll()
    }

    /// Caller invokes when the attempt ends in a terminal `.error` — i.e. the
    /// walk tried every door and reached none. Arms `redialCooldown` so the
    /// backlog of wakes that follows defers to the auto-retry ladder the caller
    /// arms alongside it, rather than each buying its own walk.
    public mutating func markAttemptFailed(at now: Date = Date()) {
        inFlight = false
        attemptStartedAt = nil
        lastAttemptFailedAt = now
        lastEstablishedAt = nil
        pendingReasons.removeAll()
    }

    public mutating func bumpGeneration() {
        generation += 1
    }

    /// Explicit disconnect / demo / host-switch: drop in-flight bookkeeping so a
    /// late walk cannot piggy-back on the old attempt, and so a later genuine
    /// wake is `.start` rather than `.supersede` against a ghost flight.
    public mutating func invalidate() {
        bumpGeneration()
        inFlight = false
        attemptStartedAt = nil
        lastAttemptFailedAt = nil
        lastEstablishedAt = nil
        pendingReasons.removeAll()
    }

    private func isConnectingPhase(_ phase: SessionPhase) -> Bool {
        switch phase {
        case .connecting, .awaitingMacConfirm: return true
        default: return false
        }
    }

    private func isInRedialCooldown(now: Date) -> Bool {
        guard redialCooldown > 0, let failed = lastAttemptFailedAt else { return false }
        // A clock that jumped backwards (NTP correction while suspended) must
        // not strand the phone behind a cooldown that can never expire.
        let elapsed = now.timeIntervalSince(failed)
        guard elapsed >= 0 else { return false }
        return elapsed < redialCooldown
    }

    private func isInPostEstablishGrace(now: Date) -> Bool {
        guard postEstablishGrace > 0, let established = lastEstablishedAt else { return false }
        let elapsed = now.timeIntervalSince(established)
        guard elapsed >= 0 else { return false }
        return elapsed < postEstablishGrace
    }

    private func shouldTreatAsTimedOut(now: Date) -> Bool {
        guard inFlight, let started = attemptStartedAt else { return false }
        return now.timeIntervalSince(started) >= connectTimeout
    }

    private mutating func beginOrSupersede(
        reason: ReconnectWakeReason,
        now: Date
    ) -> ReconnectAction {
        pendingReasons.insert(reason)
        let action: ReconnectAction = inFlight ? .supersede : .start
        // Optimistic bookkeeping so stacked wakes in the same tick coalesce
        // against the attempt the caller is about to start.
        inFlight = true
        attemptStartedAt = now
        return action
    }
}
