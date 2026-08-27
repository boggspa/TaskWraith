// TWRunActivity — the Live Activity contract for an in-flight run.
//
// ────────────────────────────────────────────────────────────────────────────
// THE CONTAINMENT RULE, READ THIS FIRST
//
// A Live Activity's content-state CANNOT be end-to-end encrypted. ActivityKit
// decodes the push payload itself and hands the struct to the widget process —
// there is no Notification-Service-Extension hook to decrypt in, the way there
// is for an alert push (see NotificationService.swift / TWPushSeal).
//
// So everything in `ContentState` is readable by Apple, and — once the Tier-2
// relay gateway lands — by the relay operator too. That is a strict downgrade
// from the alert path, where only ciphertext leaves the Mac.
//
// Therefore ContentState carries ONLY non-attributable telemetry: phase,
// counts, timestamps, and provider names. It must NEVER carry response text,
// prompts, thread or chat titles, file paths, branch names, repo or workspace
// names, or any id that links back to them. `makeContentState` is the single
// constructor and it takes only allowlisted primitives — that is the
// enforcement. Do not add a `String` field here without re-reading this block.
// ────────────────────────────────────────────────────────────────────────────
//
// Split for a reason: the DATA types below are plain Codable and compile
// everywhere, so they are unit-testable in the macOS SPM build (where `swift
// test` runs). Only the `ActivityAttributes` conformance is gated to iOS.

import Foundation

/// Which precompiled layout renders this activity. A layout is COMPILED SwiftUI
/// in the widget extension — it cannot be sent over the wire — so the user's
/// choice travels as this id and the widget switches on it. Adding a case means
/// shipping an app update; that is inherent to ActivityKit, not a limitation of
/// this design.
public enum TWActivityArchetype: String, Codable, Sendable, CaseIterable {
    /// Agent, a status dot, elapsed. Quietest.
    case minimal
    /// Adds live file/insertion/deletion counts.
    case diff
    /// Leads with the phase word — built for runs that stop and wait for you.
    case attention
    /// Per-seat state for an ensemble, with a real finished/total bar.
    case ensemble
    /// A privacy-safe roll-up for two or more monitor-authorized runs in one
    /// workspace. It carries counts and provider product names only; the
    /// workspace identity remains in TaskWraith's encrypted/local state.
    case workspace

    public static let fallback: TWActivityArchetype = .diff

    /// Whether the Mac's Notifications picker may offer this layout as the
    /// user's default. This is NOT every case: `.workspace` is DERIVED — the
    /// controller forces it for a multi-run roll-up — and it has nowhere to put
    /// a single run's detail, so offering it would be a dead radio button.
    ///
    /// Exhaustive on purpose: a new case is a compile error here until someone
    /// decides which side of the line it falls on.
    public var isUserSelectable: Bool {
        switch self {
        case .minimal, .diff, .attention, .ensemble: return true
        case .workspace: return false
        }
    }

    /// The picker's wire contract. Mirrors `ACTIVITY_ARCHETYPES` in
    /// src/shared/bannerTemplate.ts, which is itself pinned 1:1 to the radio
    /// buttons in `ACTIVITY_ARCHETYPE_PRESETS`.
    public static var userSelectable: [TWActivityArchetype] {
        allCases.filter(\.isUserSelectable)
    }
}

/// Where the user's archetype choice lives, and the on/off switch for the
/// feature. App Group backed like `TWBannerTemplateStore`, so the Mac's
/// Notifications settings tab can sync a choice over the existing
/// `bridge.broadcastBannerTemplate` channel without new plumbing.
///
/// The Mac Notifications picker sends this preference through the existing
/// appearance projection. Until a choice arrives, every activity uses
/// `TWActivityArchetype.fallback` (or `.ensemble`, forced by the chat kind).
public enum TWActivityPreferences {
    static let archetypeKey = "tw.activityArchetype.v1"
    static let enabledKey = "tw.activityEnabled.v1"

    public static func archetype(
        defaults: UserDefaults? = UserDefaults(suiteName: TWPushKeyAccess.appGroup)
    ) -> TWActivityArchetype {
        guard let raw = defaults?.string(forKey: archetypeKey) else {
            return TWActivityArchetype.fallback
        }
        // An unknown id means a NEWER build named an archetype this one cannot
        // render. Fall back rather than refuse to show the run.
        return TWActivityArchetype(rawValue: raw) ?? TWActivityArchetype.fallback
    }

    public static func isEnabled(
        defaults: UserDefaults? = UserDefaults(suiteName: TWPushKeyAccess.appGroup)
    ) -> Bool {
        // Absent ⇒ on. The whole point of the feature is being visible without
        // being asked for, and iOS already gives the user a system-level switch
        // (Settings › TaskWraith › Live Activities) that outranks this one.
        (defaults?.object(forKey: enabledKey) as? Bool) ?? true
    }

    public static func setArchetype(
        _ archetype: TWActivityArchetype,
        defaults: UserDefaults? = UserDefaults(suiteName: TWPushKeyAccess.appGroup)
    ) {
        defaults?.set(archetype.rawValue, forKey: archetypeKey)
    }

    public static func setEnabled(
        _ enabled: Bool,
        defaults: UserDefaults? = UserDefaults(suiteName: TWPushKeyAccess.appGroup)
    ) {
        defaults?.set(enabled, forKey: enabledKey)
    }

    // ── Synced diff palette ────────────────────────────────────────────────
    // The phone's own theme store is LOCAL (UserDefaults), so it has no idea
    // the Mac's diff colours were customised. These hold the pair the Mac
    // broadcasts. nil means "never synced" — NOT "black" — so the caller falls
    // back to the built-in tokens rather than painting an activity in 0x000000.

    static let successHexKey = "tw.activitySuccessHex.v1"
    static let failureHexKey = "tw.activityFailureHex.v1"

    public static func syncedSuccessHex(
        defaults: UserDefaults? = UserDefaults(suiteName: TWPushKeyAccess.appGroup)
    ) -> UInt32? {
        storedHex(defaults, successHexKey)
    }

    public static func syncedFailureHex(
        defaults: UserDefaults? = UserDefaults(suiteName: TWPushKeyAccess.appGroup)
    ) -> UInt32? {
        storedHex(defaults, failureHexKey)
    }

    private static func storedHex(_ defaults: UserDefaults?, _ key: String) -> UInt32? {
        // `object(forKey:)` rather than `integer(forKey:)`: the latter returns 0
        // for a missing key, which is indistinguishable from a legitimately
        // stored black and would silently blank the activity.
        guard let raw = defaults?.object(forKey: key) as? NSNumber else { return nil }
        return UInt32(truncatingIfNeeded: raw.intValue) & 0x00FF_FFFF
    }

    /// Applies a Mac broadcast. Each field is applied INDEPENDENTLY — a
    /// malformed colour must not also discard a perfectly good archetype.
    public static func apply(
        _ appearance: TWActivityAppearance,
        defaults: UserDefaults? = UserDefaults(suiteName: TWPushKeyAccess.appGroup)
    ) {
        if let enabled = appearance.enabled {
            defaults?.set(enabled, forKey: enabledKey)
        }
        // A KNOWN id that is not pickable means a newer Mac named a DERIVED
        // layout as the user's preference. Storing it would pin every
        // single-run activity to the roll-up, which has no room for one run's
        // detail — so it is refused exactly like an unparseable id.
        if let raw = appearance.archetype,
            let parsed = TWActivityArchetype(rawValue: raw), parsed.isUserSelectable
        {
            defaults?.set(raw, forKey: archetypeKey)
        }
        if let hex = parseHex(appearance.successColor) {
            defaults?.set(Int(hex), forKey: successHexKey)
        }
        if let hex = parseHex(appearance.failureColor) {
            defaults?.set(Int(hex), forKey: failureHexKey)
        }
    }

    /// `#RRGGBB` / `RRGGBB` / `#RGB` → 0xRRGGBB. nil on anything else.
    static func parseHex(_ raw: String?) -> UInt32? {
        guard var text = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            return nil
        }
        if text.hasPrefix("#") { text.removeFirst() }
        if text.count == 3 {
            text = text.map { "\($0)\($0)" }.joined()
        }
        guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
        return value
    }
}

/// Coarse run state. Deliberately coarse: a finer-grained phase (e.g. which
/// tool is executing) would leak what the agent is doing.
public enum TWRunPhase: String, Codable, Sendable {
    case running
    case awaitingApproval
    case awaitingQuestion
    case complete
    case failed
    case cancelled

    /// True while the run cannot proceed without the user. Drives the alert
    /// treatment and, on the `attention` archetype, the whole layout.
    public var needsUser: Bool {
        self == .awaitingApproval || self == .awaitingQuestion
    }

    public var isTerminal: Bool {
        self == .complete || self == .failed || self == .cancelled
    }
}

/// One ensemble seat. `provider` is a PRODUCT name ("codex", "claude") — not
/// user content — and is what the widget tints each dot by.
public struct TWSeatState: Codable, Hashable, Sendable {
    public let provider: String
    public let phase: TWRunPhase

    public init(provider: String, phase: TWRunPhase) {
        self.provider = provider
        self.phase = phase
    }
}

/// The mutable half of the activity. See the containment rule at the top of
/// this file before adding anything.
public struct TWRunActivityState: Codable, Hashable, Sendable {
    public let phase: TWRunPhase
    /// When the run started, as UNIX seconds — deliberately NOT a `Date`.
    ///
    /// For a PUSH-updated activity the decoder is ActivityKit's, not ours, and
    /// Swift's default date strategy (`.deferredToDate`) reads a bare number as
    /// seconds since 2001-01-01. A Mac sending unix seconds would therefore
    /// render a timer THIRTY-ONE YEARS out, silently, with no error on either
    /// side. An Int cannot be misread, so the ambiguity is removed rather than
    /// guessed at.
    ///
    /// The widget renders a live-counting timer from this rather than receiving
    /// ticks — ActivityKit updates cost a push each, so a per-second update
    /// would be absurd.
    public let startedAtUnix: Int
    public var startedAt: Date { Date(timeIntervalSince1970: TimeInterval(startedAtUnix)) }
    public let filesChanged: Int
    public let additions: Int
    public let deletions: Int
    /// Ensemble seats, empty for a solo run. Capped by `makeContentState`.
    public let seats: [TWSeatState]
    /// Number of live runs represented by this card. One for the existing
    /// per-run activity; two or more for the workspace roll-up.
    public let activeRuns: Int
    /// Local Git divergence. Counts only — no ref, branch, or remote name.
    public let ahead: Int
    public let behind: Int
    /// Distinguishes an unavailable Git observation from a genuinely clean
    /// snapshot. Zero is never allowed to impersonate unavailable.
    public let hasGitSnapshot: Bool
    /// Seats still working (wire phase `running`). Defaulted so an older Mac
    /// payload without the field remains useful: missing values are derived
    /// from `seats`, otherwise 0.
    public let activeSeats: Int
    /// Seats that have answered this turn (wire phase `complete`).
    public let respondedSeats: Int
    /// Seats with an issue (wire phase `failed`). Cancelled seats are excluded.
    public let blockedSeats: Int

    enum CodingKeys: String, CodingKey {
        case phase, startedAtUnix, filesChanged, additions, deletions, seats
        case activeRuns, ahead, behind, hasGitSnapshot
        case activeSeats, respondedSeats, blockedSeats
    }

    public init(
        phase: TWRunPhase,
        startedAtUnix: Int,
        filesChanged: Int,
        additions: Int,
        deletions: Int,
        seats: [TWSeatState],
        activeRuns: Int,
        ahead: Int,
        behind: Int,
        hasGitSnapshot: Bool,
        activeSeats: Int,
        respondedSeats: Int,
        blockedSeats: Int
    ) {
        self.phase = phase
        self.startedAtUnix = startedAtUnix
        self.filesChanged = filesChanged
        self.additions = additions
        self.deletions = deletions
        self.seats = seats
        self.activeRuns = activeRuns
        self.ahead = ahead
        self.behind = behind
        self.hasGitSnapshot = hasGitSnapshot
        self.activeSeats = activeSeats
        self.respondedSeats = respondedSeats
        self.blockedSeats = blockedSeats
    }

    /// ActivityKit can restore content written by an older app build. New
    /// anonymous counters therefore default rather than making an otherwise
    /// endable legacy activity disappear from `Activity.activities`.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        phase = (try? c.decode(TWRunPhase.self, forKey: .phase)) ?? .running
        startedAtUnix = (try? c.decode(Int.self, forKey: .startedAtUnix)) ?? 0
        filesChanged = (try? c.decode(Int.self, forKey: .filesChanged)) ?? 0
        additions = (try? c.decode(Int.self, forKey: .additions)) ?? 0
        deletions = (try? c.decode(Int.self, forKey: .deletions)) ?? 0
        seats = (try? c.decode([TWSeatState].self, forKey: .seats)) ?? []
        activeRuns = (try? c.decode(Int.self, forKey: .activeRuns)) ?? 1
        ahead = (try? c.decode(Int.self, forKey: .ahead)) ?? 0
        behind = (try? c.decode(Int.self, forKey: .behind)) ?? 0
        hasGitSnapshot = (try? c.decode(Bool.self, forKey: .hasGitSnapshot)) ?? false
        let derived = seatSummaryCounts(from: seats)
        activeSeats = Self.decodedCount(c, key: .activeSeats, fallback: derived.active)
        respondedSeats = Self.decodedCount(c, key: .respondedSeats, fallback: derived.responded)
        blockedSeats = Self.decodedCount(c, key: .blockedSeats, fallback: derived.blocked)
    }

    private static func decodedCount(
        _ c: KeyedDecodingContainer<CodingKeys>, key: CodingKeys, fallback: Int
    ) -> Int {
        if let explicit = try? c.decode(Int.self, forKey: key) {
            return max(0, explicit)
        }
        return fallback
    }

    /// ONLY set where a real denominator exists — today that is ensemble seats
    /// finished / total. An agent run has no meaningful percentage, and a bar
    /// that fills on a guess trains the user to ignore it. nil renders as an
    /// indeterminate pulse, which is honest.
    public var progress: Double? {
        guard !seats.isEmpty else { return nil }
        let done = seats.filter { $0.phase.isTerminal }.count
        return Double(done) / Double(seats.count)
    }

    public var seatsFinished: Int { seats.filter { $0.phase.isTerminal }.count }
}

/// Every colour the widget is allowed to paint with, as 0xRRGGBB, resolved ONCE
/// app-side when the activity starts.
///
/// Deliberately passed as values rather than re-derived in the widget: the
/// tables live in TaskWraithUI, which is @MainActor and pulls in UIKit/Runestone
/// — weight an extension must not carry (same reason the NSE links only
/// TaskWraithKit). Copying them into Kit would instead give us two colour
/// catalogues to keep in sync, which is a drift class this codebase has been
/// bitten by. Numbers on the wire avoid both.
public struct TWActivityPalette: Codable, Hashable, Sendable {
    /// The PROVIDER's published brand hue, already brand/spoof-resolved (an
    /// Ollama-served Qwen arrives as Alibaba purple, a Pi-served Mistral as
    /// Mistral orange) — see `TWTheme.providerAccentHex(_:modelId:modelLabel:)`.
    public let accent: UInt32
    /// The DIFF palette's add/delete pair, reused for run outcome. It is the
    /// one red/green in the product the user can define themselves, so it is
    /// the pair they already read as "good / bad".
    public let success: UInt32
    public let failure: UInt32
    /// Needs-you amber (`--status-attention`).
    public let attention: UInt32

    public init(accent: UInt32, success: UInt32, failure: UInt32, attention: UInt32) {
        self.accent = accent
        self.success = success
        self.failure = failure
        self.attention = attention
    }

    /// Desktop defaults. Only reached when an activity is decoded without a
    /// palette — see `TWRunActivityConfig.init(from:)`.
    public static let fallback = TWActivityPalette(
        accent: 0x5A8CFF, success: 0x2DB777, failure: 0xEC3D35, attention: 0xF5A623)
}

/// The immutable half — fixed when the activity starts. Layout and palette live
/// here rather than in the state because changing a layout mid-run would make
/// the island visibly rearrange itself under the user.
public struct TWRunActivityConfig: Codable, Hashable, Sendable {
    /// Provider id of the lead agent, e.g. "codex". Display only.
    public let provider: String
    public let archetype: TWActivityArchetype
    public let palette: TWActivityPalette
    /// Opaque per-run handle. NOT the runId or threadId — those would hand the
    /// relay a stable key linking activities to conversations. Generated at
    /// start and meaningless off-device.
    public let activityRef: String

    public init(
        provider: String, archetype: TWActivityArchetype, palette: TWActivityPalette,
        activityRef: String
    ) {
        self.provider = provider
        self.archetype = archetype
        self.palette = palette
        self.activityRef = activityRef
    }

    /// Hand-written so a field added in a LATER build cannot strand an activity
    /// started by an EARLIER one. ActivityKit persists attributes across app
    /// updates and hands them back through `Activity.activities`; if the decode
    /// throws, the activity is not in that list, so the new build cannot see it
    /// to end it — and an un-endable Live Activity sits on the lock screen
    /// showing a dead run until the user long-presses it away. Defaulting is
    /// strictly better than throwing here.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = (try? c.decode(String.self, forKey: .provider)) ?? "ensemble"
        archetype =
            (try? c.decode(TWActivityArchetype.self, forKey: .archetype))
            ?? TWActivityArchetype.fallback
        palette = (try? c.decode(TWActivityPalette.self, forKey: .palette)) ?? .fallback
        activityRef = (try? c.decode(String.self, forKey: .activityRef)) ?? ""
    }
}

public enum TWRunActivityLimits {
    /// ActivityKit rejects oversized content-state, and a 40-seat ensemble is
    /// unrenderable in an island anyway. Overflow is reported as a count.
    public static let maxSeats = 8

    /// How many runs may hold an activity at once. The island shows ONE; the
    /// rest queue behind it on the lock screen, so a busy ensemble morning
    /// would otherwise bury the phone.
    public static let maxConcurrent = 3

    /// How long a pushed state stays trustworthy.
    ///
    /// THIS IS THE HONESTY VALVE. Updates only happen while the app can reach
    /// the Mac; lock the phone and the relay socket drops, so without a stale
    /// date the lock screen would keep counting a timer for a run that finished
    /// twenty minutes ago. Past `staleWindow` ActivityKit sets `context.isStale`
    /// and the widget says it has lost contact instead of inventing progress.
    public static let staleWindow: TimeInterval = 8 * 60

    /// Re-push the same state this often so a long, quiet run stays fresh.
    /// Comfortably inside `staleWindow` so one missed tick is not a false stale.
    public static let heartbeat: TimeInterval = 3 * 60

    /// How long a finished run stays on screen before ActivityKit clears it.
    public static let dismissAfter: TimeInterval = 8 * 60
}

/// Counts from mapped wire seat phases: `running`→active, `complete`→responded,
/// `failed`→blocked. `cancelled` and the needs-you phases are excluded.
public func seatSummaryCounts(from seats: [TWSeatState]) -> (
    active: Int, responded: Int, blocked: Int
) {
    var active = 0, responded = 0, blocked = 0
    for seat in seats {
        switch seat.phase {
        case .running: active += 1
        case .complete: responded += 1
        case .failed: blocked += 1
        case .cancelled, .awaitingApproval, .awaitingQuestion: continue
        }
    }
    return (active, responded, blocked)
}

/// Operational copy for the ensemble Live Activity. Kept in Kit so the wording
/// is unit-testable without ActivityKit. No titles or identifiers.
public enum TWRunActivityPresentation {
    public static func ensembleStatusLabel(
        phase: TWRunPhase,
        isStale: Bool,
        activeSeats: Int,
        respondedSeats: Int
    ) -> String {
        if isStale { return "Out of contact" }
        switch phase {
        case .awaitingApproval: return "Needs approval"
        case .awaitingQuestion: return "Needs you"
        default:
            if activeSeats > 0 { return "\(activeSeats) working" }
            if respondedSeats > 0 { return "Handing off" }
            return "Preparing"
        }
    }

    public static func ensembleDetailLabel(
        respondedSeats: Int, waitingSeats: Int, blockedSeats: Int
    ) -> String {
        var text = "\(respondedSeats) responded · \(waitingSeats) waiting"
        if blockedSeats > 0 {
            text += " · \(blockedSeats) \(blockedSeats == 1 ? "issue" : "issues")"
        }
        return text
    }

    public static func ensembleCompactShowsAttention(
        isStale: Bool, needsUser: Bool, blockedSeats: Int
    ) -> Bool {
        isStale || needsUser || blockedSeats > 0
    }
}

/// THE ONLY WAY to build a content state. Takes allowlisted primitives, so a
/// caller physically cannot pass a thread title or a file path through it.
public func makeContentState(
    phase: TWRunPhase,
    startedAt: Date,
    filesChanged: Int = 0,
    additions: Int = 0,
    deletions: Int = 0,
    seats: [TWSeatState] = [],
    activeRuns: Int = 1,
    ahead: Int = 0,
    behind: Int = 0,
    hasGitSnapshot: Bool = false,
    activeSeats: Int? = nil,
    respondedSeats: Int? = nil,
    blockedSeats: Int? = nil
) -> TWRunActivityState {
    // Counts are taken from the full seat list BEFORE the payload cap, so an
    // oversized ensemble still reports how many are working even if only eight
    // dots travel on the wire.
    let derived = seatSummaryCounts(from: seats)
    return TWRunActivityState(
        phase: phase,
        startedAtUnix: Int(startedAt.timeIntervalSince1970.rounded()),
        filesChanged: max(0, filesChanged),
        additions: max(0, additions),
        deletions: max(0, deletions),
        seats: Array(seats.prefix(TWRunActivityLimits.maxSeats)),
        activeRuns: max(0, activeRuns),
        ahead: max(0, ahead),
        behind: max(0, behind),
        hasGitSnapshot: hasGitSnapshot,
        activeSeats: max(0, activeSeats ?? derived.active),
        respondedSeats: max(0, respondedSeats ?? derived.responded),
        blockedSeats: max(0, blockedSeats ?? derived.blocked)
    )
}

// `os(iOS)`, NOT `canImport(ActivityKit)`: the module imports fine on macOS but
// the ActivityAttributes protocol is marked unavailable there, so canImport
// passes and then the conformance fails to compile.
#if os(iOS)
    import ActivityKit

    /// The ActivityKit binding. iOS-only — the data types above stay portable so
    /// they remain testable in the macOS SPM build.
    @available(iOS 16.1, *)
    public struct TWRunActivityAttributes: ActivityAttributes {
        public typealias ContentState = TWRunActivityState

        public let config: TWRunActivityConfig

        public init(config: TWRunActivityConfig) {
            self.config = config
        }
    }
#endif
