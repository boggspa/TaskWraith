// TWRunActivityController — the ActivityKit half of Live Activities.
//
// Deliberately dumb. Every decision (which runs qualify, what phase they are
// in, when to start/update/finish) lives in `TWRunActivityPlanner`, which is
// pure and covered by `swift test` on macOS. This file only applies the actions
// that planner returns and owns the two things it cannot: the ActivityKit
// handles, and the resolved colour palette (TWTheme is @MainActor and lives in
// TaskWraithUI, which the widget extension must not link).
//
// TWO WRITERS, ONE CARD. This device updates the activity while it can reach
// the Mac; the moment it cannot — locking the phone drops the relay socket —
// the MAC takes over over APNs, using the push token captured below. Every
// local push still carries a `staleDate` (TWRunActivityLimits.staleWindow) so
// that if BOTH writers go quiet the card admits it rather than leaving a timer
// running forever.
//
// Releasing the token matters as much as capturing it: every teardown path
// calls `releaseToken`, because a Mac that keeps pushing into an activity this
// device already ended is writing to a card nobody can see.

#if os(iOS)
    import ActivityKit
    import Foundation
    import TaskWraithKit

    @MainActor
    public final class TWRunActivityController {
        public static let shared = TWRunActivityController()

        private var activities: [TWActivitySubject: Activity<TWRunActivityAttributes>] = [:]
        /// Last state actually handed to ActivityKit, per subject. The planner
        /// diffs against this so an unchanged projection snapshot costs nothing.
        private var pushed: [TWActivitySubject: TWRunActivityState] = [:]
        /// When this device first saw the current run of a thread, and which run
        /// that was — a follow-up turn is a new run, so the clock restarts.
        private var runStarts: [String: (runId: String, at: Date)] = [:]
        private var heartbeat: Task<Void, Never>?
        /// Retained so the heartbeat can re-push without the caller re-supplying
        /// the projection.
        private var lastPlans: [TWActivitySubject: TWActivityPlan] = [:]
        /// One per activity, cancelled when it ends. `pushTokenUpdates` is an
        /// endless AsyncSequence — leaving these running would leak a task per
        /// activity for the life of the process.
        private var tokenObservers: [TWActivitySubject: Task<Void, Never>] = [:]
        /// The opaque ref the token belongs to, per local routing subject.
        private var activityRefs: [TWActivitySubject: String] = [:]

        /// Called with the activity's push token so the host can keep the card
        /// fresh once this device stops being able to. `token == nil` means the
        /// activity ended and the host must forget it.
        ///
        /// A closure rather than a direct call because the transport lives in
        /// RemoteSessionModel, and this type must stay linkable from anywhere
        /// that can see ActivityKit.
        public var onPushToken:
            ((_ activityRef: String, _ subject: TWActivitySubject, _ token: String?) -> Void)?

        /// Called with the app-wide push-to-START token (iOS 17.2+) and this
        /// device's whole provider→accent map, so the Mac can raise an activity
        /// for a run begun while this app was not even running.
        ///
        /// The map travels because the Mac has NO provider-hex table of its own —
        /// Swift has one and theme.css has one, and adding a third for this would
        /// be the duplicate-catalogue drift class. The device that owns the table
        /// ships it, so it is correct by construction.
        public var onPushToStartToken: ((_ token: String, _ accents: [String: UInt32]) -> Void)?

        private var pushToStartObserver: Task<Void, Never>?
        /// Activities that existed before this launch. Ended rather than adopted
        /// — see `reconcileOrphans`.
        private var didReconcileOrphans = false

        public init() {}

        // MARK: - Entry point

        /// Called from `RemoteSessionModel.taskCards.didSet`. Cheap on the common
        /// path: with nothing changed the planner returns an empty action list.
        public func sync(
            cards: [RemoteTaskCard],
            diffs: [String: MobileDiffSummary],
            ensembles: [String: RemoteEnsembleState],
            gitSnapshots: [String: GitWorkspaceSnapshot],
            isDemo: Bool,
            now: Date = Date()
        ) {
            guard !isDemo else { return endAll() }
            guard TWActivityPreferences.isEnabled(),
                ActivityAuthorizationInfo().areActivitiesEnabled
            else { return endAll() }

            reconcileOrphans()
            observePushToStartToken()

            let plans = TWRunActivityPlanner.plans(
                cards: cards,
                diffs: diffs,
                ensembles: ensembles,
                gitSnapshots: gitSnapshots,
                startedAt: { [weak self] card in self?.startDate(for: card, now: now) ?? now })
            lastPlans = Dictionary(
                plans.map { ($0.subject, $0) }, uniquingKeysWith: { a, _ in a })

            for action in TWRunActivityPlanner.actions(plans: plans, owned: pushed) {
                apply(action, now: now)
            }
            let projectedRunIds = Set(
                cards.compactMap { card in
                    TWRunActivityPlanner.phase(forCardStatus: card.status) == nil ? nil : card.id
                })
            runStarts = runStarts.filter { projectedRunIds.contains($0.key) }
            refreshHeartbeat()
        }

        /// Host switch, forget-host, sign-out, demo entry. A Live Activity that
        /// outlived its Mac would keep one host's run on the lock screen after
        /// the user moved to another — the same "leave nothing readable" rule
        /// `clearCachedProjectionState` follows for the caches.
        public func endAll() {
            heartbeat?.cancel()
            heartbeat = nil
            let live = activities
            for subject in live.keys { releaseToken(subject: subject) }
            activities = [:]
            pushed = [:]
            runStarts = [:]
            lastPlans = [:]
            for (_, observer) in tokenObservers { observer.cancel() }
            tokenObservers = [:]
            activityRefs = [:]
            for (_, activity) in live {
                Task { await activity.end(nil, dismissalPolicy: .immediate) }
            }
        }

        // MARK: - Applying actions

        private func apply(_ action: TWActivityAction, now: Date) {
            switch action {
            case .start(let plan):
                start(plan, now: now)
            case .update(let plan):
                update(plan, now: now)
            case .finish(let plan):
                finish(plan)
            case .abandon(let subject):
                abandon(subject)
            }
        }

        private func start(_ plan: TWActivityPlan, now: Date) {
            let activityRef = UUID().uuidString
            let config = TWRunActivityConfig(
                provider: plan.provider,
                // An ensemble chat FORCES the ensemble archetype: the other three
                // have nowhere to put per-seat state, so honouring a "minimal"
                // preference here would silently drop the only thing that makes
                // an ensemble worth watching.
                archetype: plan.isWorkspace
                    ? .workspace
                    : (plan.isEnsemble ? .ensemble : TWActivityPreferences.archetype()),
                palette: palette(for: plan),
                activityRef: activityRef)
            do {
                let activity = try Activity.request(
                    attributes: TWRunActivityAttributes(config: config),
                    content: content(plan.state, now: now),
                    // `.token`, so the Mac can take over updating this card the
                    // moment we can no longer reach it — which is as soon as the
                    // phone locks and the relay socket drops.
                    pushType: .token)
                activities[plan.subject] = activity
                activityRefs[plan.subject] = activityRef
                pushed[plan.subject] = plan.state
                observeToken(for: activity, subject: plan.subject, activityRef: activityRef)
            } catch {
                // Throws when the user has Live Activities off system-wide, or
                // when the app is over its concurrent limit. Neither is worth
                // surfacing — the run is visible everywhere else in the app.
                pushed[plan.subject] = nil
            }
        }

        private func update(_ plan: TWActivityPlan, now: Date) {
            guard let activity = activities[plan.subject] else { return }
            pushed[plan.subject] = plan.state
            let content = content(plan.state, now: now)
            let alert = alertConfiguration(for: plan.state.phase)
            Task { await activity.update(content, alertConfiguration: alert) }
        }

        private func finish(_ plan: TWActivityPlan) {
            guard let activity = activities.removeValue(forKey: plan.subject) else { return }
            pushed[plan.subject] = nil
            if let threadId = plan.subject.threadId { runStarts[threadId] = nil }
            releaseToken(subject: plan.subject)
            // No staleDate on the terminal push: the run is over, so the state
            // cannot go out of date. Giving it one would grey out a perfectly
            // accurate outcome after eight minutes.
            let content = ActivityContent(state: plan.state, staleDate: nil)
            Task {
                await activity.end(
                    content,
                    dismissalPolicy: .after(
                        Date().addingTimeInterval(TWRunActivityLimits.dismissAfter)))
            }
        }

        private func abandon(_ subject: TWActivitySubject) {
            guard let activity = activities.removeValue(forKey: subject) else { return }
            pushed[subject] = nil
            releaseToken(subject: subject)
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }

        // MARK: - Push tokens

        /// End any activity that outlived the process — one the Mac push-STARTED
        /// while this app was closed, or one that survived a crash.
        ///
        /// Ended rather than adopted, deliberately. Adoption would need to map
        /// the activity back to a thread, and the thread id is precisely what the
        /// attributes do NOT carry (that is the containment rule). Without a
        /// mapping we cannot update it correctly, and leaving it alone would let
        /// the local lifecycle start a SECOND card for the same run. Ending it
        /// costs a brief flicker before the local one replaces it; the
        /// alternative is a duplicate or a lie.
        private func reconcileOrphans() {
            guard !didReconcileOrphans else { return }
            didReconcileOrphans = true
            let known = Set(activities.values.map(\.id))
            for activity in Activity<TWRunActivityAttributes>.activities where !known.contains(activity.id) {
                Task { await activity.end(nil, dismissalPolicy: .immediate) }
            }
        }

        /// iOS 17.2+. GATED, not floor-bumped: the app supports 17.0, and an
        /// activity started on-device still works there — push-to-start is an
        /// extra, not a requirement.
        private func observePushToStartToken() {
            guard pushToStartObserver == nil else { return }
            guard #available(iOS 17.2, *) else { return }
            pushToStartObserver = Task { [weak self] in
                for await tokenData in Activity<TWRunActivityAttributes>.pushToStartTokenUpdates {
                    if Task.isCancelled { return }
                    let hex = tokenData.map { String(format: "%02x", $0) }.joined()
                    await self?.emitPushToStartToken(hex)
                }
            }
        }

        private func emitPushToStartToken(_ hex: String) {
            onPushToStartToken?(hex, TWTheme.providerAccentMap())
        }

        private func observeToken(
            for activity: Activity<TWRunActivityAttributes>, subject: TWActivitySubject,
            activityRef: String
        ) {
            tokenObservers[subject]?.cancel()
            tokenObservers[subject] = Task { [weak self] in
                // Endless sequence: iOS re-issues on rotation. It only completes
                // when the activity ends, so the cancel in `releaseToken` is what
                // actually stops it in the common case.
                for await tokenData in activity.pushTokenUpdates {
                    if Task.isCancelled { return }
                    let hex = tokenData.map { String(format: "%02x", $0) }.joined()
                    await self?.emitToken(activityRef: activityRef, subject: subject, token: hex)
                }
            }
        }

        private func emitToken(
            activityRef: String, subject: TWActivitySubject, token: String?
        ) {
            onPushToken?(activityRef, subject, token)
        }

        /// Tell the host to forget this activity, and stop watching for tokens.
        /// Called on every teardown path — miss one and the Mac keeps pushing
        /// into a card that no longer exists.
        private func releaseToken(subject: TWActivitySubject) {
            tokenObservers.removeValue(forKey: subject)?.cancel()
            guard let activityRef = activityRefs.removeValue(forKey: subject) else { return }
            onPushToken?(activityRef, subject, nil)
        }

        // MARK: - Freshness

        private func content(_ state: TWRunActivityState, now: Date) -> ActivityContent<
            TWRunActivityState
        > {
            ActivityContent(
                state: state,
                staleDate: now.addingTimeInterval(TWRunActivityLimits.staleWindow),
                // Waiting runs sort above merely-running ones when several
                // activities compete for the Dynamic Island.
                relevanceScore: state.phase.needsUser ? 2 : 1)
        }

        /// Re-push unchanged state periodically so a long, quiet run does not
        /// cross its stale date while we are still perfectly in touch with it.
        private func refreshHeartbeat() {
            guard !activities.isEmpty else {
                heartbeat?.cancel()
                heartbeat = nil
                return
            }
            guard heartbeat == nil else { return }
            heartbeat = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(
                        nanoseconds: UInt64(TWRunActivityLimits.heartbeat * 1_000_000_000))
                    if Task.isCancelled { return }
                    await self?.beat()
                }
            }
        }

        private func beat() {
            guard !activities.isEmpty else {
                heartbeat?.cancel()
                heartbeat = nil
                return
            }
            let now = Date()
            for (subject, activity) in activities {
                guard let state = pushed[subject] else { continue }
                let content = content(state, now: now)
                Task { await activity.update(content) }
            }
        }

        // MARK: - Palette + clock

        /// The ONE place a colour is resolved. Brand/spoof-aware, so an
        /// Ollama-served Qwen wears Alibaba purple and a Pi-served Mistral wears
        /// Mistral orange, exactly as the transcript does.
        private func palette(for plan: TWActivityPlan) -> TWActivityPalette {
            TWActivityPalette(
                accent: TWTheme.providerAccentHex(plan.provider, modelId: plan.model),
                // The diff pair, not the run-status pair. It is the red/green the
                // user can define themselves, so it is the one they already read
                // as good/bad — and it is what the ± counters in this very
                // activity are painted with.
                //
                // Prefer the pair the Mac broadcast (settings.diffStatColors);
                // TWTheme's constants are only the desktop DEFAULTS, so using
                // them unconditionally would ignore a user who recoloured their
                // diffs. nil — never synced — falls back rather than painting
                // black.
                success: TWActivityPreferences.syncedSuccessHex() ?? TWTheme.diffStatAddHex,
                failure: TWActivityPreferences.syncedFailureHex() ?? TWTheme.diffStatDelHex,
                attention: TWTheme.statusAttentionHex)
        }

        private func startDate(for card: RemoteTaskCard, now: Date) -> Date {
            let runId = card.runId ?? ""
            if let existing = runStarts[card.id], existing.runId == runId { return existing.at }
            runStarts[card.id] = (runId: runId, at: now)
            return now
        }

        /// Only the two phases that need a human get to buzz. A completion
        /// already fires its own banner (CompletionBannerRenderer), so alerting
        /// here as well would double-notify the same event.
        private func alertConfiguration(for phase: TWRunPhase) -> AlertConfiguration? {
            guard phase.needsUser else { return nil }
            return AlertConfiguration(
                title: "Waiting on you",
                body: phase == .awaitingApproval
                    ? "A run needs approval to continue."
                    : "A run asked you a question.",
                sound: .default)
        }
    }
#endif
