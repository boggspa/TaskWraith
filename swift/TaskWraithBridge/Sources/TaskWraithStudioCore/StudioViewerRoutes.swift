import Foundation

/// The two viewer routes the owner-approved briefing requires.
///
/// 00-BRIEFING.md:142-155: "Two viewer routes, one playback authority... The
/// routes may be independently toggled... Hiding a route releases or hibernates
/// its decoder/player resources; two viewers must never become two clocks."
public enum StudioViewerRoute: String, CaseIterable, Equatable, Sendable {
    /// Previews the selected asset independently of the timeline.
    case source
    /// Plays the committed timeline or the open ghost proposal.
    case review

    public var windowTitle: String {
        switch self {
        case .source: return "TaskWraith Studio — Source"
        case .review: return "TaskWraith Studio — Review"
        }
    }
}

/// THE ONE PLAYBACK AUTHORITY, held by reference so two routes cannot become
/// two clocks.
///
/// WHY A CLASS. StudioTransportController is a VALUE type and so is the clock
/// inside it. Two views each holding their own `var transport` would be two
/// independent clocks that happened to start together and drift apart — the
/// briefing names that outcome as prohibited, and value semantics would produce
/// it silently and by construction rather than by mistake. Reference identity
/// is what makes "one clock" a fact about the object graph instead of a
/// convention someone has to remember.
public final class StudioPlaybackAuthority {
    /// The single transport. Every route reads and mutates THIS.
    public var transport: StudioTransportController

    public init(clock: StudioPlaybackClock) {
        self.transport = StudioTransportController(clock: clock)
    }

    /// Replaces the clock when a new asset is opened. Routes see it at once
    /// because they share this object rather than a copy of it.
    public func adopt(clock: StudioPlaybackClock) {
        transport = StudioTransportController(clock: clock)
    }
}

/// Which routes are visible, and what hiding one is obliged to do.
///
/// Kept in Core rather than the window layer because "hiding releases decoder
/// resources" is a CONTRACT, not a UI detail — and a contract that lives only
/// in glue is one nothing can test.
public struct StudioRouteVisibility: Equatable, Sendable {
    public private(set) var visible: Set<StudioViewerRoute>

    /// Source opens by default; Review appears when there is something to
    /// review. Opening both at once would spend decoder resources on a route
    /// with nothing in it.
    public init(visible: Set<StudioViewerRoute> = [.source]) {
        self.visible = visible.isEmpty ? [.source] : visible
    }

    public func isVisible(_ route: StudioViewerRoute) -> Bool {
        visible.contains(route)
    }

    /// Toggles a route and reports what the caller must do about resources.
    ///
    /// AT LEAST ONE ROUTE STAYS VISIBLE. Hiding the last one would leave a
    /// running companion with no window, which reads as a crash to an operator
    /// and cannot be recovered without the host.
    @discardableResult
    public mutating func toggle(_ route: StudioViewerRoute) -> StudioRouteTransition {
        if visible.contains(route) {
            guard visible.count > 1 else { return .refused(reason: .lastVisibleRoute) }
            visible.remove(route)
            return .hidden(route)
        }
        visible.insert(route)
        return .shown(route)
    }
}

public enum StudioRouteTransition: Equatable, Sendable {
    public enum RefusalReason: String, Equatable, Sendable {
        case lastVisibleRoute
    }

    case shown(StudioViewerRoute)
    /// The caller MUST release that route's decoder/player resources. Returning
    /// this rather than doing it here keeps the value type free of ownership,
    /// while still making the obligation explicit at every call site.
    case hidden(StudioViewerRoute)
    case refused(reason: RefusalReason)

    /// True when this transition obliges the caller to release resources.
    public var requiresResourceRelease: Bool {
        if case .hidden = self { return true }
        return false
    }
}
