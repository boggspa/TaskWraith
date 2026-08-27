import Foundation
import TaskWraithKit

/// How reachable the paired Mac is, projected for the phone's UI.
///
/// This is a PROJECTION of vocabulary that already exists on the wire
/// (`HostConnectionPhase`, `HostHealthStatus`, `HostProjectionFreshness`) plus
/// the local `SessionPhase` and the relay transport's own health. It is
/// deliberately NOT a fourth wire enum: nothing here is transmitted, decoded, or
/// persisted as protocol state, and adding a case to this file must never imply
/// a host-side change.
///
/// ## The honesty contract (read before editing `copy`)
///
/// The phone cannot distinguish a sleeping Mac from a crashed one, a quit app,
/// a paused VM, or a machine whose network stack died mid-flight. All four look
/// identical from here: the relay path is up, and the peer never answers.
/// `asleep` is therefore an INTERNAL case name describing the *evidence shape*
/// (transport healthy, peer silent) — it is not a claim about the Mac's power
/// state, and `HostLivenessCopy` must never render it as one.
///
/// This matters because the feature it serves is "make host-offline HONEST".
/// A confident "Your Mac is asleep" that is actually a crash sends the user to
/// wiggle a mouse instead of relaunching the app, which is worse than the
/// ambiguity we started with. Hedged phrasing ("may be asleep, busy, or closed")
/// is permitted and matches the existing "busy or asleep" copy elsewhere in the
/// app; a bare assertion is not.
///
/// If a future change gives us real evidence — a Mac-side `powerMonitor` signal
/// crossing the bridge, or a last-seen heartbeat — then and only then may the
/// copy assert sleep, and the doc comment on `HostLivenessCopy.asleep` should be
/// updated in the same commit that adds the evidence.
public enum HostLiveness: String, Sendable, Equatable, Hashable, CaseIterable, Codable {
    /// Session established, projection fresh, peer answering.
    case live
    /// Session established, but the view is cached/aging or the host reports
    /// degraded health. Everything on screen is real; some of it is old.
    case stale
    /// Transport is healthy and the peer is not answering.
    /// See the honesty contract above — this is an evidence shape, not a
    /// statement about the Mac being asleep.
    case asleep
    /// No usable route to the Mac at all: the transport itself is down, the host
    /// reported unavailable, or the protocol is incompatible.
    case unreachable

    /// Whether an outbound composer send should be diverted into the offline
    /// outbox instead of being attempted immediately.
    ///
    /// `stale` deliberately returns `false`: a cached projection does NOT mean
    /// the send path is broken, and queueing a send that would have succeeded is
    /// its own small dishonesty (the user is told "saved for later" about
    /// something that could have run now).
    public var shouldQueueOutbound: Bool {
        switch self {
        case .live, .stale: return false
        case .asleep, .unreachable: return true
        }
    }

    /// Whether this state warrants interrupting the user with a banner.
    public var warrantsBanner: Bool { self != .live }
}

/// Inputs to the liveness derivation.
///
/// Every field is supplied by the caller — this type performs no I/O, reads no
/// singleton, and holds no reference to `RemoteSessionModel`. That keeps the
/// whole derivation exhaustively testable without a relay, a host, or a mic of
/// state to stand up.
public struct HostLivenessInputs: Sendable, Equatable {
    /// The phone's own pairing/session state machine.
    public var sessionPhase: SessionPhase
    /// Host-reported connection phase, when a projection has been seen.
    /// `nil` means NO EVIDENCE and never counts toward `.live`.
    public var connectionPhase: HostConnectionPhase?
    /// Host-reported health, when a projection has been seen.
    /// `nil` means NO EVIDENCE and never counts toward `.live`.
    public var health: HostHealthStatus?
    /// How old the projection on screen is.
    /// `nil` means NO EVIDENCE and never counts toward `.live`.
    public var freshness: HostProjectionFreshness?
    /// Is the relay socket itself up? This is the *path*, not the peer.
    public var transportHealthy: Bool
    /// Has a peer-directed ack/ping failed since the last success? This is the
    /// *peer*, not the path. The asymmetry between this and `transportHealthy`
    /// is the only honest evidence we have for `.asleep`.
    public var peerAckFailing: Bool

    public init(
        sessionPhase: SessionPhase,
        connectionPhase: HostConnectionPhase? = nil,
        health: HostHealthStatus? = nil,
        freshness: HostProjectionFreshness? = nil,
        transportHealthy: Bool = true,
        peerAckFailing: Bool = false
    ) {
        self.sessionPhase = sessionPhase
        self.connectionPhase = connectionPhase
        self.health = health
        self.freshness = freshness
        self.transportHealthy = transportHealthy
        self.peerAckFailing = peerAckFailing
    }
}

extension HostLiveness {
    /// Derive a liveness projection, or `nil` when no honest judgement is
    /// available yet.
    ///
    /// `nil` is returned for `.idle`, `.connecting`, and `.awaitingMacConfirm` —
    /// states in which we have not finished trying. Painting an in-progress dial
    /// as `.unreachable` would be exactly the lie this type exists to prevent,
    /// so callers should fall through to the existing connection banner and
    /// render no liveness cell at all.
    ///
    /// Precedence is deliberate and ordered from strongest evidence to weakest:
    ///   1. no session yet            -> nil (or `.unreachable` for a hard error)
    ///   2. host says unavailable     -> unreachable
    ///   3. transport down           -> unreachable  (checked before the peer:
    ///                                  a peer ack over a dead socket proves
    ///                                  nothing about the peer)
    ///   4. peer silent, path up     -> asleep       (the asymmetry, D2)
    ///   5. host reports offline     -> unreachable
    ///   6. anything less than fully fresh -> stale
    ///   7. positive evidence on ALL THREE -> live
    ///
    /// Note step 6/7: `live` is the NARROW case and `stale` is the fallback,
    /// and **absence is not freshness**. `live` requires a POSITIVE `.live`
    /// phase, a POSITIVE `.live` freshness and a POSITIVE `.ok` health; a `nil`
    /// on any of them means "we have no evidence", which degrades to `.stale`.
    ///
    /// An earlier version of this function defaulted the three optionals to
    /// their happy values, so a bare connected session with no projection at all
    /// rendered as `.live`. That is the exact failure this type exists to
    /// prevent — missing evidence becoming a positive claim — and the copy-level
    /// honesty tests did not catch it, because the lie was in the derivation
    /// rather than in the words. Do not reintroduce a `?? .live` / `?? .ok`
    /// default here.
    public static func derive(_ inputs: HostLivenessInputs) -> HostLiveness? {
        switch inputs.sessionPhase {
        case .idle, .connecting, .awaitingMacConfirm:
            // Still trying. No judgement is honest yet.
            return nil
        case .error:
            return .unreachable
        case .connected:
            break
        }

        // 2 — the host itself told us it is not there.
        if let phase = inputs.connectionPhase {
            switch phase {
            case .hostUnavailable, .offline:
                return .unreachable
            case .incompatibleProtocol:
                // Present but unusable. `unreachable` is the closest of the four
                // cases and is the fail-safe direction (queue rather than send).
                // The banner copy for this case is owned by the existing
                // incompatible-protocol surface, not by us.
                return .unreachable
            case .connecting, .live, .reconnecting, .staleCache:
                break
            }
        }

        // 3 — path before peer. Order matters: a failed peer ack over a dead
        // socket is evidence about the socket, not about the Mac.
        guard inputs.transportHealthy else { return .unreachable }

        // 4 — the asymmetry. Path up, peer silent.
        if inputs.peerAckFailing { return .asleep }

        // 5 — host-reported offline health with a live path is still no host.
        if inputs.health == .offline { return .unreachable }

        // 6/7 — `live` demands POSITIVE evidence on all three. A `nil` is
        // absence of evidence, not evidence of health, so it falls to `.stale`
        // through the same guard. No `??` defaults here, deliberately.
        guard inputs.connectionPhase == .live,
            inputs.freshness == .live,
            inputs.health == .ok
        else { return .stale }

        return .live
    }

    /// Adapter from the paired-host replica the model already owns into the
    /// six-input honesty contract above. A live replica is itself positive
    /// transport evidence: those health bytes arrived over the authenticated
    /// host session. Cached/unavailable replicas are not.
    public static func derive(
        sessionPhase: SessionPhase,
        projectionPhase: PairedHostProjectionPhase,
        healthProjection: HostHealthProjection?,
        probeLedger: HostLivenessProbeLedger,
        now: Date = Date()
    ) -> HostLiveness? {
        derive(
            HostLivenessInputs(
                sessionPhase: sessionPhase,
                connectionPhase: healthProjection?.connectionPhase,
                health: healthProjection?.hostStatus,
                freshness: healthProjection?.freshness,
                transportHealthy: projectionPhase == .live
                    || probeLedger.transportHealthy(at: now),
                peerAckFailing: probeLedger.peerAckFailing(at: now)))
    }
}

/// User-facing strings for a liveness state.
///
/// Kept separate from the enum so copy can be reviewed as copy. See the honesty
/// contract on `HostLiveness` before changing `asleep`.
public struct HostLivenessCopy: Sendable, Equatable {
    /// Short banner title.
    public var headline: String
    /// One-sentence explanation.
    public var detail: String
    /// What the composer says when it accepts a prompt into the outbox instead
    /// of sending it. `nil` when sends are attempted normally.
    public var queueNotice: String?

    public init(headline: String, detail: String, queueNotice: String?) {
        self.headline = headline
        self.detail = detail
        self.queueNotice = queueNotice
    }
}

extension HostLiveness {
    /// The approved copy for each state.
    ///
    /// `asleep` **must not** assert that the Mac is asleep — see the honesty
    /// contract on `HostLiveness`. The hedged list below is deliberate and is
    /// the whole point of this item; an editor "tightening" it to
    /// "Your Mac is asleep" reintroduces the bug this file was written to fix.
    public var copy: HostLivenessCopy {
        switch self {
        case .live:
            return HostLivenessCopy(
                headline: "Connected",
                detail: "Your Mac is answering and this view is current.",
                queueNotice: nil
            )
        case .stale:
            return HostLivenessCopy(
                headline: "Showing your last synced view",
                detail: "Still connected, but some of what you see may be out of date.",
                queueNotice: nil
            )
        case .asleep:
            return HostLivenessCopy(
                headline: "Your Mac isn't answering",
                detail:
                    "The connection is up, but your Mac hasn't replied. It may be asleep, busy, or TaskWraith may have closed.",
                queueNotice: "Saved. This sends as soon as your Mac answers."
            )
        case .unreachable:
            return HostLivenessCopy(
                headline: "Can't reach your Mac",
                detail: "TaskWraith can't find a route to your Mac right now.",
                queueNotice: "Saved. This sends when you're reconnected."
            )
        }
    }
}

// MARK: - Pass-2 integration surface
//
// This module is intentionally headless. `ComposerView.swift` and
// `RemoteSessionModel.swift` are owned by other lanes this pass, so nothing here
// is wired. A pass-2 integration lane should:
//
//  1. Build `HostLivenessInputs` at the call site that already knows all six
//     values — `sessionPhase` from the model, the three host fields from the
//     current `PairedHostProjection`, `transportHealthy` from the relay client's
//     socket state, and `peerAckFailing` from the wake/ack path that already
//     distinguishes a healthy socket from a silent peer.
//  2. Call `HostLiveness.derive(_:)`. On `nil`, render nothing new and leave the
//     existing `ConnectionBanner` in charge.
//  3. Render `copy.headline` / `copy.detail` in the connection banner area.
//  4. In the composer send path, branch on `shouldQueueOutbound`: when true,
//     enqueue through `OfflineComposerQueue` and surface `copy.queueNotice`
//     instead of the current behaviour, which restores the draft and shows a
//     failure. When false, send as today.
//  5. Flush the outbox when the session reaches `.connected` — see the flush
//     contract in `OfflineComposerQueue`.
//
// Deliberately NOT decided here: whether the liveness cell lives in the thread
// header or the composer rail. That is a design call, and this type serves
// either.

/// Records what the health probes `RemoteSessionModel` ALREADY runs returned,
/// and derives the two `HostLivenessInputs` fields nothing else exposes:
/// `transportHealthy` and `peerAckFailing`.
///
/// ## Why this type exists (R1)
///
/// `HostLiveness.asleep` claims "the path is up and your Mac is silent". That is
/// only honest if it rests on the TRUE socket-vs-peer split — never on a generic
/// send timeout, which cannot tell a sleeping Mac from a dead network. Wiring a
/// timeout here would quietly restore the guess this feature exists to
/// eliminate, and the copy-honesty tests above would still pass, because they
/// guard the rendered words rather than the quality of the input.
///
/// `RemoteSessionModel` funnels both probes through one choke point
/// (`runConnectedHealthProbe`): `checkSocketAlive()` when `peer == false`,
/// `checkPeerAlive()` when `peer == true`. This ledger records what those
/// returned. It NEVER initiates a probe of its own — that file's reconnect-storm
/// history is emphatic that stacking probes is how the storm starts, and a
/// banner is not worth a dial.
///
/// ## The evidence rule
///
/// `asleep` requires POSITIVE evidence on BOTH halves: the last peer probe
/// failed, AND the socket was observed alive within `socketFreshness`.
///
/// A failed peer probe alone is not evidence the path is healthy — it may have
/// failed precisely because the socket died. With no fresh socket observation
/// this reports `transportHealthy == false`, which derives `.unreachable`
/// rather than `.asleep`: it fails toward the state that claims less. Same
/// discipline as the removed `?? .live` defaults above — absence of evidence
/// must never become a positive claim.
public struct HostLivenessProbeLedger: Sendable, Equatable {
    /// How recently the socket must have been seen alive for a peer failure to
    /// count as the asleep asymmetry rather than a dead path.
    ///
    /// Sized against the probe cadence documented in `RemoteSessionModel` (a
    /// relay ping is ~2.5s, an encrypted peer ping ~6s): 30s spans "the socket
    /// was fine moments ago" without letting a minutes-old observation vouch
    /// for a path that has since died.
    public static let defaultSocketFreshness: TimeInterval = 30

    public var socketFreshness: TimeInterval

    /// When the transport was last positively observed alive. A successful PEER
    /// probe also sets this — reaching the peer proves the socket carried it.
    public private(set) var lastSocketAliveAt: Date?
    /// Whether the most recent peer probe failed. Cleared by any peer success.
    public private(set) var peerProbeFailing: Bool

    public init(
        socketFreshness: TimeInterval = defaultSocketFreshness,
        lastSocketAliveAt: Date? = nil,
        peerProbeFailing: Bool = false
    ) {
        self.socketFreshness = socketFreshness
        self.lastSocketAliveAt = lastSocketAliveAt
        self.peerProbeFailing = peerProbeFailing
    }

    /// Record one probe outcome. Call from the existing probe choke point only.
    ///
    /// - Parameters:
    ///   - alive: what the probe returned.
    ///   - peer: `true` for `checkPeerAlive`, `false` for `checkSocketAlive`.
    public mutating func record(alive: Bool, peer: Bool, at now: Date) {
        if peer {
            peerProbeFailing = !alive
            if alive { lastSocketAliveAt = now }
        } else if alive {
            lastSocketAliveAt = now
        } else {
            // The path itself is down. A standing peer verdict is now
            // unattributable — it may have failed BECAUSE of this — so it must
            // not go on vouching for the asleep asymmetry.
            peerProbeFailing = false
            lastSocketAliveAt = nil
        }
    }

    /// Forget everything. Call on teardown / host switch, so one Mac's evidence
    /// can never describe another.
    public mutating func reset() {
        lastSocketAliveAt = nil
        peerProbeFailing = false
    }

    /// Positive, bounded evidence that the transport is up.
    public func transportHealthy(at now: Date) -> Bool {
        guard let lastSocketAliveAt else { return false }
        return now.timeIntervalSince(lastSocketAliveAt) <= socketFreshness
    }

    /// Positive evidence that the Mac is not answering over a path we can still
    /// vouch for. Both halves are required — see the evidence rule above.
    public func peerAckFailing(at now: Date) -> Bool {
        peerProbeFailing && transportHealthy(at: now)
    }
}
