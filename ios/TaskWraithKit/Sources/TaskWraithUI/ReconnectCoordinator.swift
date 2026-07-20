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
public struct ReconnectCoordinator: Sendable, Equatable {
    public var generation: Int
    public var inFlight: Bool
    public var attemptStartedAt: Date?
    public var pendingReasons: Set<ReconnectWakeReason>
    public var connectTimeout: TimeInterval

    public init(
        generation: Int = 0,
        inFlight: Bool = false,
        attemptStartedAt: Date? = nil,
        pendingReasons: Set<ReconnectWakeReason> = [],
        connectTimeout: TimeInterval = 15
    ) {
        self.generation = generation
        self.inFlight = inFlight
        self.attemptStartedAt = attemptStartedAt
        self.pendingReasons = pendingReasons
        self.connectTimeout = connectTimeout
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
            return beginOrSupersede(reason: reason, now: now)
        }
    }

    /// Caller invokes after acting on `.start` / `.supersede`.
    public mutating func markAttemptStarted(at now: Date = Date()) {
        inFlight = true
        attemptStartedAt = now
    }

    /// Caller invokes when the attempt reaches `.connected` or a terminal `.error`.
    public mutating func markAttemptFinished() {
        inFlight = false
        attemptStartedAt = nil
        pendingReasons.removeAll()
    }

    public mutating func bumpGeneration() {
        generation += 1
    }

    private func isConnectingPhase(_ phase: SessionPhase) -> Bool {
        switch phase {
        case .connecting, .awaitingMacConfirm: return true
        default: return false
        }
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
