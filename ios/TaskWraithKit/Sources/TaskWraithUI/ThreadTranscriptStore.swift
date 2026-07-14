import Combine
import Foundation
import TaskWraithKit

/// Per-thread re-render gate for the transcript.
///
/// `RemoteSessionModel` is one monolithic `ObservableObject` (~30 `@Published`),
/// so a view holding `@ObservedObject var model` re-evaluates its WHOLE body on
/// ANY `@Published` mutation anywhere — another thread's streamed token, a git
/// pull, a usage refresh. `ThreadDetailTranscriptBody` instead observes THIS
/// store (a small `ObservableObject`), which subscribes to the model's slices
/// and forwards `objectWillChange` only when the currently-open thread's relevant
/// data changes.
///
/// Two tiers:
///  - SCOPED per-thread (the hot cascade sources): the streaming dicts, this
///    thread's snapshot + ensemble state, and its task card. Each fires only when
///    THIS thread's slice actually changes (`removeDuplicates`), so another
///    thread's tokens / card status flips no longer re-render the open transcript.
///  - BROAD pass-through (everything else the transcript reads): diff summaries,
///    git snapshots (workspace-keyed, not thread-keyed), the global row-expansion
///    sets, approvals/questions, and the global surfaces. These fire on any
///    change — same cadence as today — so nothing they drive can silently stop
///    updating. They're low-frequency relative to streaming, so broad is fine.
///
/// The view keeps a plain `let model` for reads (fresh each render) and method
/// calls; the store is purely a "when to re-render" gate — no read is rewritten.
///
/// Two subtleties this design deliberately handles (both surfaced by an
/// adversarial review of the first cut):
///
///  1. `@Published` publishes on `willSet`, so re-reading `model.taskCards` /
///     `model.threadSnapshots` from INSIDE their own sink returns the
///     PRE-mutation value. Key derivation therefore reads `latestCards` /
///     `latestSnaps` — fresh copies stamped from each publisher's emitted value —
///     never the model's stored properties.
///
///  2. Streaming for a brand-new/ensemble sub-thread can arrive under the Mac's
///     wire thread-id BEFORE the projection snapshot that tells iOS that id
///     aliases the open `taskId` (separate wire paths, unordered over the relay).
///     Slicing with a stale key set would swallow it (`removeDuplicates` sees
///     nil→nil). So a change to the alias key set FIRES unconditionally: the view
///     then re-reads every dict with its own fresh `resolvedThreadKeys`, picking
///     up streaming that landed early under the just-registered alias.
///
/// Binding is synchronous (`.onAppear` + `.onChange(of: taskId)`), not
/// `.task(id:)`: the async `Task` hop left a window where the view had already
/// rendered the new thread but the store wasn't wired yet, and any change landing
/// in that gap was silently absorbed as the baseline. Binding lets the initial
/// `@Published` replays fire (one coalesced catch-up render per bind — cheap, as
/// binds are per thread-switch, not per token), guaranteeing the store never
/// starts a thread one update behind.
@MainActor
final class ThreadTranscriptStore: ObservableObject {
    private var cancellables: Set<AnyCancellable> = []
    private var model: RemoteSessionModel?
    private var taskId: String = ""

    /// Fresh copies of the alias sources, stamped from their OWN publishers so key
    /// derivation never re-reads a `@Published` stored property mid-`willSet`
    /// (which would see the pre-mutation value).
    private var latestCards: [RemoteTaskCard] = []
    private var latestSnaps: [String: RemoteThreadSnapshot] = [:]
    /// Alias keys mirroring `ThreadDetailView.resolvedThreadKeys` (shared via
    /// `resolvedThreadKeys(taskId:cards:snapshots:)`). Cached so per-token
    /// streaming slicing stays O(keys); recomputed on every alias-source emission.
    private var cachedKeys: [String] = []
    /// Last-seen scoped slices for the two alias pipelines, so they fire on a
    /// this-thread card/snapshot change as well as on a key-set change.
    private var lastCard: RemoteTaskCard?
    private var lastSnap: RemoteThreadSnapshot?

    /// (Re)bind to a thread. Called from `.onAppear` (first mount) and
    /// `.onChange(of: taskId)` (in-place swap) — both synchronous, so no model
    /// mutation can interleave between the view's render and the wire-up — tearing
    /// down the previous thread's subscriptions and wiring the new thread's.
    func bind(model: RemoteSessionModel, taskId: String) {
        cancellables.removeAll()
        self.model = model
        self.taskId = taskId
        latestCards = model.taskCards
        latestSnaps = model.threadSnapshots
        cachedKeys = Self.resolvedThreadKeys(
            taskId: taskId, cards: latestCards, snapshots: latestSnaps)
        lastCard = card(latestCards)
        lastSnap = slice(latestSnaps)
        wire()
    }

    /// Single source of truth for "which keys alias this thread", shared with
    /// `ThreadDetailView.resolvedThreadKeys` so the gate can never fire on a
    /// different key set than the view actually reads. Order matters: `taskId`
    /// first, then the card's ids, then the taskId-keyed snapshot's aliases.
    static func resolvedThreadKeys(
        taskId: String,
        cards: [RemoteTaskCard],
        snapshots: [String: RemoteThreadSnapshot]
    ) -> [String] {
        var seen: Set<String> = []
        var keys: [String] = []
        func append(_ key: String?) {
            guard let key = key?.trimmingCharacters(in: .whitespacesAndNewlines),
                !key.isEmpty, !seen.contains(key)
            else { return }
            seen.insert(key)
            keys.append(key)
        }
        let card = cards.first { $0.id == taskId || $0.threadId == taskId }
        append(taskId)
        append(card?.id)
        append(card?.threadId)
        append(snapshots[taskId]?.taskId)
        append(snapshots[taskId]?.threadId)
        return keys
    }

    private func slice<T>(_ dict: [String: T]) -> T? {
        for k in cachedKeys { if let v = dict[k] { return v } }
        return nil
    }

    private func card(_ cards: [RemoteTaskCard]) -> RemoteTaskCard? {
        cards.first { $0.id == taskId || $0.threadId == taskId }
    }

    private func fire() {
        objectWillChange.send()
    }

    private func wire() {
        guard let model else { return }

        // ---- ALIAS SOURCES: keep a fresh copy, recompute keys, fire on a
        //      key-set change OR this thread's own card/snapshot slice change.
        //      Reading the emitted value (not `model.taskCards`) sidesteps the
        //      `willSet` staleness; firing on any key-set change closes the
        //      streaming-arrives-before-its-alias ordering hole. ----
        model.$taskCards
            .sink { [weak self] cards in
                guard let self else { return }
                self.latestCards = cards
                let before = self.cachedKeys
                self.cachedKeys = Self.resolvedThreadKeys(
                    taskId: self.taskId, cards: cards, snapshots: self.latestSnaps)
                let newCard = self.card(cards)
                if self.cachedKeys != before || newCard != self.lastCard {
                    self.lastCard = newCard
                    self.fire()
                }
            }
            .store(in: &cancellables)
        model.$threadSnapshots
            .sink { [weak self] snaps in
                guard let self else { return }
                self.latestSnaps = snaps
                let before = self.cachedKeys
                self.cachedKeys = Self.resolvedThreadKeys(
                    taskId: self.taskId, cards: self.latestCards, snapshots: snaps)
                let newSnap = self.slice(snaps)
                if self.cachedKeys != before || newSnap != self.lastSnap {
                    self.lastSnap = newSnap
                    self.fire()
                }
            }
            .store(in: &cancellables)

        // ---- SCOPED: fire only when THIS thread's slice changes. cachedKeys is
        //      kept fresh by the alias pipelines above, and any key-set change
        //      already fired there, so an early-arriving streaming burst under a
        //      just-registered alias is caught by the view's re-read. ----
        model.$streamingTexts
            .map { [weak self] dict in self.flatMap { s in s.slice(dict) } }
            .removeDuplicates().sink { [weak self] _ in self?.fire() }.store(in: &cancellables)
        model.$streamingSegments
            .map { [weak self] dict in self.flatMap { s in s.slice(dict) } }
            .removeDuplicates().sink { [weak self] _ in self?.fire() }.store(in: &cancellables)
        model.$streamingRunIds
            .map { [weak self] dict in self.flatMap { s in s.slice(dict) } }
            .removeDuplicates().sink { [weak self] _ in self?.fire() }.store(in: &cancellables)
        model.$streamingProviders
            .map { [weak self] dict in self.flatMap { s in s.slice(dict) } }
            .removeDuplicates().sink { [weak self] _ in self?.fire() }.store(in: &cancellables)
        // Terminal membership flips WITHOUT an accompanying text/segment change
        // (agent-exit after the last coalesce window republishes identical
        // staging, which removeDuplicates swallows) — without this pipeline the
        // reveal drain never re-renders on the store-gated transcript view.
        model.$streamingTerminalThreads
            .map { [weak self] set in
                self.flatMap { s in s.cachedKeys.contains(where: set.contains) } ?? false
            }
            .removeDuplicates().sink { [weak self] _ in self?.fire() }.store(in: &cancellables)
        model.$ensembleStates
            .map { [weak self] dict in self.flatMap { s in s.slice(dict) } }
            .removeDuplicates().sink { [weak self] _ in self?.fire() }.store(in: &cancellables)

        // ---- BROAD: fire on any change (unchanged cadence — low-frequency, or
        //      genuinely hard to key by thread: gitSnapshots is workspace-keyed,
        //      expandingRows is a global row-id set). Broad ⇒ nothing here can
        //      silently stop updating. ----
        let broad: [AnyPublisher<Void, Never>] = [
            model.$diffSummaries.map { _ in () }.eraseToAnyPublisher(),
            model.$gitSnapshots.map { _ in () }.eraseToAnyPublisher(),
            model.$rowExpansions.map { _ in () }.eraseToAnyPublisher(),
            model.$expandingRows.map { _ in () }.eraseToAnyPublisher(),
            model.$loadingPreviousThreadRows.map { _ in () }.eraseToAnyPublisher(),
            model.$wakeRefreshGeneration.map { _ in () }.eraseToAnyPublisher(),
            model.$repliedProposedPlanIds.map { _ in () }.eraseToAnyPublisher(),
            model.$approvals.map { _ in () }.eraseToAnyPublisher(),
            model.$questions.map { _ in () }.eraseToAnyPublisher(),
            model.$workspaces.map { _ in () }.eraseToAnyPublisher(),
            model.$workflows.map { _ in () }.eraseToAnyPublisher(),
            model.$providerModels.map { _ in () }.eraseToAnyPublisher(),
            model.$welcomeDashboard.map { _ in () }.eraseToAnyPublisher(),
            model.$usageRollup.map { _ in () }.eraseToAnyPublisher(),
            model.$phase.map { _ in () }.eraseToAnyPublisher(),
            model.$macDisplayName.map { _ in () }.eraseToAnyPublisher(),
            model.$lastActionMessage.map { _ in () }.eraseToAnyPublisher(),
            model.$isDemo.map { _ in () }.eraseToAnyPublisher(),
            model.$firstLaunchState.map { _ in () }.eraseToAnyPublisher(),
            model.$projectedShellAppearance.map { _ in () }.eraseToAnyPublisher(),
            // Read directly in the body via onChange/sheet — must re-eval the body
            // (composer "Add to prompt", inspector sheet, roster sheet).
            model.$composerAppendRequest.map { _ in () }.eraseToAnyPublisher(),
            model.$inspectorPresented.map { _ in () }.eraseToAnyPublisher(),
            model.$rosterPresented.map { _ in () }.eraseToAnyPublisher(),
        ]
        Publishers.MergeMany(broad).sink { [weak self] _ in self?.fire() }.store(in: &cancellables)
    }
}
