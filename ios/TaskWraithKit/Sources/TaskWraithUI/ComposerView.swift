// SwiftUI surface for the TaskWraith companion.
//
// Design direction (see ios/DESIGN.md): borrow the *format* of the Claude /
// Codex iOS apps — workspaces-as-projects home, thread view with collapsed
// history + tool chips, pill composer — but skinned entirely in TaskWraith's
// own theme tokens (TWTheme mirrors the desktop theme.css). iPhone focuses on
// solid thread management; iPad gets the sidebar (NavigationSplitView) where
// advanced affordances will live. Pure SwiftUI so `swift build` compile-checks
// on macOS; QR camera scanning is the one `#if os(iOS)` extra.

import SwiftUI
import TaskWraithKit

#if canImport(UIKit)
    import PhotosUI
    import UIKit

    private let twMaxComposerImageAttachments = 15
#endif

struct Composer: View {
    @ObservedObject var model: RemoteSessionModel
    let card: RemoteTaskCard
    @Environment(\.appScale) private var appScale
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    /// Compact VERTICAL class is the reliable "phone is in landscape" signal —
    /// see `compactPickerDetail`.
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    /// Short viewport: iPhone in landscape, and only there (iPad reports a
    /// regular vertical class in both orientations).
    ///
    /// The composer wraps a ~20pt text line in ~30pt of vertical padding — 8pt
    /// on the input row plus 7pt on the body, doubled. That is invisible in
    /// portrait's 874pt and expensive in landscape's ~342pt: with the keyboard
    /// up it is the difference between roughly one line of visible transcript
    /// and three. Halved here rather than removed, so the input still reads as
    /// a field rather than a hairline.
    private var compactHeight: Bool { verticalSizeClass == .compact }
    var runModel: String? = nil
    var runStatus: String? = nil
    /// Shell attachment: a diff header above / telemetry rail below flatten
    /// the touching corners so the three rows read as ONE container
    /// (desktop composer-shell parity).
    var attachedTop: Bool = false
    var attachedBottom: Bool = false
    /// false = sends must not move the shell's selection (side-chat mini
    /// pane: the side chat stays in the inspector column while the parent
    /// stays in the main pane, both active simultaneously).
    var navigateOnSend: Bool = true
    /// Secondary workspace granted to this send (rail picker selection).
    var extraWorkspaceIds: [String]? = nil
    /// When set, send starts a new Mac thread instead of continuing `card`.
    var newTaskWorkspaceId: String? = nil
    /// Mirrors the internal provider selection out to hosts that theme
    /// surrounding chrome by provider (the new-chat canvas hero/chips).
    var providerEcho: Binding<String>? = nil
    /// Existing chats normally keep their provider. Empty transcript welcome
    /// screens may still choose the first-turn provider before dispatch.
    var allowsProviderChange: Bool? = nil
    /// Idle-collapse plumbing: the host passes `onExpandedChange` to mirror the
    /// composer's expanded state (so it can hide its secondary rows + telemetry
    /// rail when the composer is idle); `forcesExpanded` keeps the composer
    /// always-open (welcome hero, ensemble roster).
    var onExpandedChange: ((Bool) -> Void)? = nil
    /// Mirrors raw input focus (keyboard up). Distinct from `onExpandedChange`,
    /// which also stays true while a draft/queued prompt lingers after blur —
    /// the host uses focus to hide the ABOVE rows when the keyboard drops.
    var onFocusChange: ((Bool) -> Void)? = nil
    var forcesExpanded: Bool = false
    @Binding var text: String

    @State private var approvalMode = "default"
    /// Drives compact (idle) vs full composer — focusing the field expands it.
    /// Plain `@State` (not `@FocusState`): on iOS the input is the UIKit-backed
    /// `MentionTextView`, which owns first-responder status and mirrors it back
    /// through a Bool binding. `@FocusState`/`.focused()` only bind to SwiftUI
    /// views, so a representable can't use them.
    @State private var inputFocused: Bool = false
    /// Drives the context-donut → context-meter popover.
    @State private var showContextMeter = false
    /// Native iOS schedule sheet for queued future sends.
    @State private var showScheduleSheet = false
    /// Scope-global chat — every phone-origin turn is clamped to the
    /// read-only floor by the Mac; the composer pins the picker to match.
    private var isGlobalChat: Bool {
        card.isGlobalScope && newTaskWorkspaceId == nil
    }
    private var bridgeApprovalMode: String? {
        if isGlobalChat { return "plan" }
        switch approvalMode {
        case "read_only", "plan":
            return "plan"
        case "default":
            return nil
        case "full_access":
            // Full access runs auto_edit; the Mac gates it against the workspace
            // allowlist (permissionPresetId → auto_edit in approvalModeFromPayload)
            // and re-signs the full_access posture. Paired with
            // bridgePermissionPresetId below.
            return "auto_edit"
        default:
            return approvalMode
        }
    }
    private var bridgeWorkflowMode: String? {
        !isGlobalChat && approvalMode == "plan" ? "plan" : nil
    }
    /// The composer's single "Full access" tier maps to the signed `full_access`
    /// preset on the Mac (single-provider parity with the ensemble roster). Only
    /// emitted for a non-global workspace chat; nil otherwise.
    private var bridgePermissionPresetId: String? {
        !isGlobalChat && approvalMode == "full_access" ? "full_access" : nil
    }
    private var approvalIconName: String {
        switch approvalMode {
        case "plan": return "list.bullet.clipboard"
        case "read_only": return "eye"
        case "full_access": return "bolt.fill"
        default: return "checkmark.shield"
        }
    }
    private var approvalDisplayLabel: String {
        switch approvalMode {
        case "plan": return "Plan"
        case "read_only": return "Read-Only/Recon"
        case "full_access": return "Full Access"
        default: return "Default"
        }
    }
    @State private var selectedProvider: String = "claude"
    @State private var selectedModelId: String?
    @State private var selectedReasoningEffort: String?
    @State private var selectedFastMode: Bool = false
    @State private var selectedKimiThinking: Bool = true
    #if canImport(UIKit)
        @State private var pickedItems: [PhotosPickerItem] = []
        @State private var attachments: [(name: String, image: UIImage)] = []
    #endif

    /// Participants available to @-mention: a true ensemble's round participants.
    /// Idle ensembles already have empty round participants, so the suggestion
    /// chips stay hidden for them (no regression), and non-ensemble chats have no
    /// projected participants at all.
    private var mentionParticipants: [RemoteEnsembleState.Participant] {
        model.ensembleStates[card.id]?.displayParticipants ?? []
    }

    /// Trailing "@token" under the cursor → mention suggestions.
    private var mentionQuery: String? {
        guard !mentionParticipants.isEmpty else { return nil }
        guard let at = text.lastIndex(of: "@") else { return nil }
        let tail = text[text.index(after: at)...]
        guard !tail.contains(" "), !tail.contains("\n") else { return nil }
        return String(tail)
    }

    private var mentionCandidates: [MentionCandidate] {
        guard let query = mentionQuery else { return [] }
        let all = twMentionCandidates(participants: mentionParticipants)
        guard !query.isEmpty else { return all }
        return all.filter {
            $0.display.lowercased().hasPrefix(query.lowercased())
                || $0.insertText.lowercased().hasPrefix("@" + query.lowercased())
        }
    }

    private var accent: Color {
        card.isEnsemble
            ? TWTheme.chroma2
            : TWTheme.providerAccent(selectedProvider, modelId: cardSelectedModelId)
    }

    /// The resolved composer shell for the active style (default unless the Mac
    /// projects, or the user overrides, another). Drives per-style body theming.
    private var shell: ResolvedComposerShell { twResolvedComposerShell(model: model) }
    private var providerName: String {
        TWTheme.providerLabel(selectedProvider, modelId: cardSelectedModelId)
    }
    private var canChangeProvider: Bool {
        allowsProviderChange ?? (newTaskWorkspaceId != nil)
    }
    private var providerAdmission: ComposerProviderAdmission {
        resolveComposerProviderAdmission(
            selectedProvider: selectedProvider,
            cardProvider: card.provider,
            canChangeProvider: canChangeProvider,
            isNewTask: newTaskWorkspaceId != nil,
            dynamicallySelectableProviderIds: dynamicallySelectableProviderIds)
    }
    private var providerUnavailableReason: String? {
        providerAdmission.unavailableReason
    }
    private var cardSelectedModelId: String? {
        guard let selected = nonEmpty(card.selectedModelType), selected != "default" else {
            return nil
        }
        if selected == "custom" {
            return nonEmpty(card.customModel)
        }
        return selected
    }
    private var cardReasoningEffort: String? {
        let provider = (card.provider ?? selectedProvider).lowercased()
        if provider == "claude" {
            return nonEmpty(card.claudeReasoningEffort)
        }
        if provider == "codex" {
            return nonEmpty(card.codexReasoningEffort)
        }
        if provider == "kimi" {
            return nonEmpty(card.kimiReasoningEffort)
        }
        return nil
    }
    // Fast toggle + Kimi thinking the loaded thread last used (provider-specific
    // wire fields). Cursor/Claude are Bools; Codex uses a 'fast' service tier.
    private var cardFastMode: Bool {
        switch (card.provider ?? selectedProvider).lowercased() {
        case "cursor": return card.cursorFastMode ?? false
        case "claude": return card.claudeFastMode ?? false
        case "codex": return card.codexServiceTier == "fast"
        case "kimi": return card.kimiFastMode ?? false
        default: return false
        }
    }
    private var cardKimiThinking: Bool { true }
    /// Only carry the Kimi thinking flag for Kimi runs (nil for everyone else).
    private var effectiveKimiThinking: Bool? {
        selectedProvider.lowercased() == "kimi" ? true : nil
    }
    private var isEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private var hasQueued: Bool {
        !(card.queuedComposerPrompts ?? []).isEmpty
    }
    /// Compact (idle) when the field is unfocused, empty, and has nothing
    /// pending. Anything queued/typed/attached — or a host that forces it —
    /// keeps the composer expanded so controls + rows + rail stay visible.
    private var isExpanded: Bool {
        forcesExpanded || inputFocused || !isEmpty || hasImageAttachments || hasQueued
    }
    /// Run id of a live stream for this thread, if one is in flight. The
    /// Mac-pushed `card.runId` is snapshot-throttled and lags the un-throttled
    /// stream, so we fall back to this so Stop is targetable the moment tokens
    /// start arriving.
    private var liveStreamRunId: String? {
        guard let live = model.streamingTexts[card.id], !live.isEmpty else { return nil }
        return model.streamingRunIds[card.id]
    }
    /// The run id to cancel: the throttled card field if present, else the live
    /// stream's run id. Mirrors the gate in `RemoteSessionModel.cancelRun`.
    private var effectiveRunId: String? {
        card.runId ?? liveStreamRunId
    }
    private var isRunActive: Bool {
        let status = runStatus ?? card.status
        // A run parked on an approval/question is still live + cancellable —
        // `deriveTaskStatus` reports those states instead of "running". And a
        // live stream means a run is in flight even before the throttled card
        // projection flips to "running" (and during the ~900ms it lingers after
        // exit, where cancelling an already-finished run is a safe no-op).
        if status == "running" || status == "awaitingApproval" || status == "awaitingQuestion" {
            return true
        }
        return liveStreamRunId != nil
    }
    private var canCancelRun: Bool {
        isRunActive && effectiveRunId != nil && (card.capabilities?.cancel ?? true)
    }
    private var hasImageAttachments: Bool {
        #if canImport(UIKit)
            return !attachments.isEmpty
        #else
            return false
        #endif
    }
    private var canQueueCurrentPrompt: Bool {
        providerAdmission.isLive
            && isRunActive && newTaskWorkspaceId == nil && !isEmpty && !hasImageAttachments
    }
    private var canScheduleFromThisComposer: Bool {
        providerAdmission.isLive
            && !card.isEnsemble
            && ((newTaskWorkspaceId?.isEmpty == false) || !(card.workspaceId ?? "").isEmpty)
    }
    private var scheduleValidationReason: String? {
        if let providerUnavailableReason {
            return providerUnavailableReason
        }
        if card.isEnsemble {
            return "Ensemble scheduling is not available on iOS yet."
        }
        if !canScheduleFromThisComposer {
            return "Scheduling requires a workspace-backed chat."
        }
        if hasImageAttachments {
            return "Scheduled image attachments from paired devices are not supported yet."
        }
        if isEmpty {
            return "Prompt required"
        }
        return nil
    }
    private var catalogs: [ProviderModelCatalog] {
        twOfferedProviderCatalogs(
            model.providerModels,
            including: [card.provider, selectedProvider].compactMap { $0 })
    }

    private var dynamicallySelectableProviderIds: Set<String> {
        Set(
            model.providerModels.compactMap { provider, models in
                TWTheme.isProviderOfferedByModelCatalog(provider, models: models)
                    && !TWTheme.isLiveSelectableProvider(provider)
                    ? provider.lowercased() : nil
            })
    }

    /// Phone / compact-width: Claude/Codex-style single shell — model +
    /// approval live inside the input card (trailing action strip) instead of
    /// a second full-width band, reclaiming transcript height.
    private var foldsControlsIntoInput: Bool {
        #if os(iOS)
            horizontalSizeClass != .regular
        #else
            false
        #endif
    }

    var body: some View {
        // CS12: input-owning shells gap the framed input from the bare control
        // row below it (desktop flex-column gap); others stay flush (spacing 0).
        VStack(alignment: .leading, spacing: shell.layout.inputOwnsSurface ? 6 : 0) {
            if let providerUnavailableReason {
                Label(providerUnavailableReason, systemImage: "exclamationmark.shield")
                    .font(.caption)
                    .foregroundStyle(TWTheme.statusAttention)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .accessibilityLabel(providerUnavailableReason)
            }
            if foldsControlsIntoInput {
                // Compact phone chrome: one card, controls folded into the input
                // footer (Claude/Codex). No separate model/approval band.
                composerInputBody
            } else if shell.layout.controlsBelowTextarea {
                // CS10: text input first, control row BELOW it (codex/claude/…
                // desktop parity). No hairline — the controls float under the
                // input separated only by the rows' own padding, mirroring the
                // desktop inner-module `gap`.
                composerInputBody
                if !card.isEnsemble {
                    composerControlsRow
                }
            } else {
                // Signed-off native arrangement: controls ABOVE the input with a
                // hairline divider. Unchanged (default parity on regular width).
                if !card.isEnsemble {
                    composerControlsRow
                    if isExpanded {
                        Rectangle().fill(TWTheme.border).frame(height: 1)
                    }
                }
                composerInputBody
            }
        }
        // Fade the control row ⇄ compact-pill swap on focus/idle transitions.
        // Scoped to isExpanded so only those two views animate — nothing else in
        // the body changes on this value.
        .animation(ComposerMotion.inlineFade, value: isExpanded)
        // Re-bind the picker to the LOADED thread on first appear AND on every
        // thread switch. SwiftUI reuses this Composer instance across threads on
        // iPhone (the compact nav destination has no per-thread `.id`), so a
        // one-shot seed would leak thread A's model/reasoning into thread B.
        .onChange(of: card.id, initial: true) {
            resyncPickerToThread()
            // Composer is reused across threads on iPhone (no per-thread .id) —
            // clear focus so thread B doesn't inherit thread A's expanded state.
            inputFocused = false
        }
        .onChange(of: isExpanded, initial: true) { _, expanded in
            onExpandedChange?(expanded)
        }
        .onChange(of: inputFocused, initial: true) { _, focused in
            onFocusChange?(focused)
        }
        .onChange(of: selectedProvider) { _, newValue in
            providerEcho?.wrappedValue = newValue
        }
        .onChange(of: runModel) { _, newValue in
            // The on-demand snapshot usually lands AFTER the composer appears
            // (same thread, so the resync above does not re-fire). Backfill the
            // pill with the thread's actual run model when we don't yet have a
            // selection. User picks are never overwritten.
            if selectedModelId == nil, let newValue {
                selectedModelId = newValue
            }
        }
        .onChange(of: cardReasoningEffort) { _, newValue in
            // Same late-snapshot backfill for reasoning effort, which otherwise
            // has no recovery path once the per-thread resync has run.
            if selectedReasoningEffort == nil, let newValue {
                selectedReasoningEffort = newValue
            }
        }
        .sheet(isPresented: $showScheduleSheet) {
            ComposerScheduleSheet(
                threadTitle: card.title ?? providerName,
                validationReason: scheduleValidationReason,
                onSchedule: { runAt in
                    scheduleCurrent(runAt: runAt)
                }
            )
            .twSheetLiquidGlass(detents: [.medium, .large])
        }
    }

    @ViewBuilder
    private var composerBodyBackground: some View {
        // Per-style card-in-card fill (e.g. codex #252525). Default keeps the
        // native input-row fill (signed-off). Other shells with no inner module
        // let the shell surface show through (terminal green, satellite/modular
        // transparent, stub cream) rather than painting the theme input fill.
        if shell.layout.inputOwnsSurface {
            // CS12: the input gets its OWN shell surface (bubble/capsule/rect)
            // applied in composerInputBody — don't double-paint a fill here.
            Color.clear
        } else if let fill = shell.palette.innerModuleFill {
            Rectangle().fill(fill)
        } else if shell.style == .defaultShell {
            Rectangle().fill(composerInputRowFill())
        } else {
            Color.clear
        }
    }

    /// CS12 — background behind the control row. Bare (clear) for input-owning
    /// shells whose footer floats free (claude/gemini/cursor) or gets its own rect
    /// (obsidian/alabaster, via .composerShellIf below); codex fuses the row into
    /// its #252525 inner module; everyone else keeps the attached-row fill.
    private var composerControlsRowFill: AnyShapeStyle {
        if shell.layout.inputOwnsSurface {
            return AnyShapeStyle(Color.clear)
        }
        if shell.material == .transparent {
            // CS12d (Codex review P2-2): modular/satellite float their controls
            // free — their innerModuleFill is the textarea pill ONLY, not a
            // full-width footer strip. Don't fuse the control row into it.
            return AnyShapeStyle(Color.clear)
        }
        if let fill = shell.palette.innerModuleFill {
            return AnyShapeStyle(fill)
        }
        return composerAttachedRowFill()
    }

    @ViewBuilder
    private var composerControlsRow: some View {
        // Collapse the whole control row when the composer is idle/unfocused to
        // give the transcript more vertical room. The model/reasoning picker
        // stays reachable via a tiny pill in the input row's top-left corner
        // (compactModelPickerControl); focusing expands the full row back.
        if isExpanded {
            HStack(spacing: 8) {
                modelPickerControl
                // Reflect a Mac-queued mid-run provider switch (rare + salient).
                pendingProviderPill
                composerControlSeparator
                approvalControl
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(Rectangle().fill(composerControlsRowFill))
            // CS12: two-rect shells (obsidian/alabaster) give the control row its
            // OWN lit rect; bare-footer shells leave it transparent.
            .composerShellIf(shell.layout.splitChromeRects, shell)
            .transition(.opacity)
        }
    }

    @ViewBuilder
    private var pendingProviderPill: some View {
        if let pending = card.pendingProviderChange, let prov = pending.provider {
            HStack(spacing: 3) {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.system(size: 9, weight: .semibold))
                Text("→ \(TWTheme.providerLabel(prov)) at turn end")
                    .font(.caption2.weight(.medium))
                    .lineLimit(1)
            }
            .foregroundStyle(TWTheme.textSecondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(TWTheme.surface3, in: Capsule())
            .accessibilityLabel(
                "Provider switching to \(TWTheme.providerLabel(prov)) at turn end")
        }
    }

    /// How much the idle composer's picker pill spells out.
    ///
    /// Ensemble chats stay on the bare glyph: that composer sends to a roster,
    /// so naming one model would misrepresent what is about to run.
    ///
    /// For single-provider chats the split is by available width, and it
    /// deliberately reads BOTH size classes. `horizontalSizeClass == .regular`
    /// alone catches iPad and the Max-class phones in landscape but leaves every
    /// other landscape phone on the portrait treatment — which is precisely the
    /// case with width to spare. A compact VERTICAL class is the reliable "phone
    /// is on its side" signal, so it earns the fuller label too.
    ///
    /// CAVEAT, verified against Info.plist rather than assumed: the iPhone
    /// target is portrait-ONLY (`UISupportedInterfaceOrientations` lists just
    /// `Portrait`; the ~ipad variant lists all four). iPad is regular/regular in
    /// both orientations. So today the vertical clause never fires and this
    /// reduces to "iPad". It is kept because it is the correct rule the moment
    /// the phone target gains landscape — but do NOT read it as load-bearing
    /// now, and do not "verify" it on an iPhone: that state does not exist.
    private var compactPickerDetail: ProviderModelPicker.CompactDetail {
        if card.isEnsemble { return .glyphOnly }
        let roomy = horizontalSizeClass == .regular || verticalSizeClass == .compact
        return roomy ? .modelAndReasoning : .model
    }

    /// Tiny picker pill for the idle/unfocused composer's top-left corner —
    /// same picker + popover as `modelPickerControl`, just a compact trigger.
    @ViewBuilder
    private var compactModelPickerControl: some View {
        if !catalogs.isEmpty {
            ProviderModelPicker(
                catalogs: catalogs,
                provider: $selectedProvider,
                modelId: $selectedModelId,
                reasoningEffort: $selectedReasoningEffort,
                fastModeEnabled: $selectedFastMode,
                kimiThinkingEnabled: $selectedKimiThinking,
                allowsProviderChange: canChangeProvider,
                compact: true,
                compactDetail: compactPickerDetail)
            .transition(.opacity)
        }
    }

    @ViewBuilder
    private var modelPickerControl: some View {
        if !catalogs.isEmpty {
            ProviderModelPicker(
                catalogs: catalogs,
                provider: $selectedProvider,
                modelId: $selectedModelId,
                reasoningEffort: $selectedReasoningEffort,
                fastModeEnabled: $selectedFastMode,
                kimiThinkingEnabled: $selectedKimiThinking,
                allowsProviderChange: canChangeProvider)
        } else {
            Text(providerName)
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(accent.opacity(0.16), in: Capsule())
                .overlay(Capsule().strokeBorder(accent.opacity(0.45)))
                .foregroundStyle(accent)
            if let runModel {
                Text(runModel)
                    .font(.caption2)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(TWTheme.surface3, in: Capsule())
                    .foregroundStyle(TWTheme.textSecondary)
                    .lineLimit(1)
            }
        }
    }

    /// CS12: control-chip fill — bare (clear) for plain-text shells (cursor /
    /// satellite / obsidian / alabaster), else the standard surface3 chip. The
    /// model picker is already flat; this flattens the approval token to match.
    private var controlChipFill: AnyShapeStyle {
        shell.layout.controlsAsPlainText
            ? AnyShapeStyle(Color.clear) : AnyShapeStyle(TWTheme.surface3)
    }

    @ViewBuilder
    private var approvalControl: some View {
        if isGlobalChat {
            // T72 — phone-origin turns in global chats ALWAYS run in
            // read-only mode (the Mac forces it server-side; this chip
            // tells the truth instead of offering a dead picker).
            HStack(spacing: 3) {
                Image(systemName: "eye")
                Text("Read-Only/Recon")
            }
            .font(twComposerFont(shell.fontDesign, .caption2))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(controlChipFill, in: twControlShape(shell.geometry.controlShape))
            .foregroundStyle(TWTheme.textSecondary)
        } else {
            Menu {
                Picker("Approval", selection: $approvalMode) {
                    Label("Read-Only/Recon", systemImage: "eye").tag("read_only")
                    Label("Default Approval", systemImage: "checkmark.shield").tag("default")
                    Label("Plan workflow", systemImage: "list.bullet.clipboard").tag("plan")
                    Label("Full Access", systemImage: "bolt.fill").tag("full_access")
                }
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: approvalIconName)
                    Text(approvalDisplayLabel)
                }
                .font(twComposerFont(shell.fontDesign, .caption2))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(controlChipFill, in: twControlShape(shell.geometry.controlShape))
                .foregroundStyle(TWTheme.textSecondary)
            }
            .accessibilityLabel("Approval mode")
            .accessibilityValue(approvalDisplayLabel)
        }
    }

    private var composerControlSeparator: some View {
        Rectangle()
            .fill(TWTheme.border.opacity(0.75))
            .frame(width: 1, height: 18)
    }

    /// The composer's editable text field. On iOS this is the UITextView-backed
    /// `MentionTextView` (so @mentions can be tinted inline — a later slice); the
    /// macOS compile-check build (no UIKit) keeps a plain SwiftUI `TextField`.
    /// Both honour the same shell font design + text colour.
    @ViewBuilder private var composerTextInput: some View {
        #if canImport(UIKit)
            // `.frame(maxWidth: .infinity)` makes the representable greedy-horizontal
            // like the old TextField — without it, a representable falls back to its
            // UITextView intrinsic width and won't fill the row.
            MentionTextView(
                text: $text,
                focused: $inputFocused,
                participants: mentionParticipants,
                font: twUIComposerFont(shell.fontDesign, scale: appScale),
                textColor: shell.palette.textPrimary,
                placeholderColor: shell.palette.placeholder,
                placeholder: placeholder
            )
            .frame(maxWidth: .infinity, alignment: .leading)
        #else
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(1...2)
                .font(twComposerFont(shell.fontDesign))
                .foregroundStyle(shell.palette.textPrimary)
        #endif
    }

    private var composerInputBody: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !mentionCandidates.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(mentionCandidates) { candidate in
                            let chipAccent = TWTheme.providerAccent(
                                candidate.provider, modelId: candidate.model, modelLabel: candidate.model)
                            Button {
                                insertMention(candidate)
                            } label: {
                                HStack(spacing: 4) {
                                    Circle().fill(chipAccent).frame(width: 5, height: 5)
                                    Text(candidate.display)
                                        .font(.caption2.weight(.semibold))
                                }
                                .padding(.horizontal, 8).padding(.vertical, 4)
                                .background(chipAccent.opacity(0.14), in: Capsule())
                                .overlay(Capsule().strokeBorder(chipAccent.opacity(0.4)))
                                .foregroundStyle(chipAccent)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Mention \(candidate.display)")
                            .accessibilityHint("Inserts mention into message.")
                        }
                    }
                }
            }
            #if canImport(UIKit)
                if !attachments.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(Array(attachments.enumerated()), id: \.offset) {
                                index, attachment in
                                ZStack(alignment: .topTrailing) {
                                    Image(uiImage: attachment.image)
                                        .resizable()
                                        .scaledToFill()
                                        .frame(width: 52, height: 52)
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                    Button {
                                        attachments.remove(at: index)
                                    } label: {
                                        Image(systemName: "xmark.circle.fill")
                                            .font(.caption)
                                            .foregroundStyle(.white, .black.opacity(0.6))
                                    }
                                    .offset(x: 5, y: -5)
                                    .accessibilityLabel("Remove attached image \(index + 1)")
                                }
                            }
                        }
                        .padding(.top, 4)
                    }
                }
            #endif
            // Input cluster: the composer body supplies the darker fill, so
            // this row stays flat like the desktop central panel.
            //
            // Compact phone (foldsControlsIntoInput): Claude/Codex layout —
            // text on its own line, then a thin action strip with model +
            // approval + trailing send controls. Regular-width keeps the
            // single-row cluster (model/approval stay in the separate band).
            // Ensemble is deliberately excluded from the two-row fold and falls
            // through to the single-row branch below.
            //
            // That second row exists to carry the model picker, pending-provider
            // pill, approval control and schedule button — and every one of them
            // is `!card.isEnsemble`-gated, because an ensemble's models come from
            // the roster, not a composer chip. So for an ensemble the row holds
            // nothing but a Spacer and the trailing send cluster, which the
            // single-row branch already places inline with the input. It was a
            // whole row of height (~34pt) buying nothing.
            //
            // The two branches are content-identical for an ensemble: same
            // photos button, caret, input, queue button, context donut and
            // primary action, with the picker/schedule suppressed either way.
            if foldsControlsIntoInput && !card.isEnsemble {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .bottom, spacing: 8) {
                        #if canImport(UIKit)
                            photosButton
                        #endif
                        if shell.effects.contains(.terminalCaret) {
                            Text(">")
                                .font(twComposerFont(.monospaced).weight(.bold))
                                .foregroundStyle(shell.sendButton.tint)
                        }
                        composerTextInput
                    }
                    HStack(spacing: 6) {
                        if !card.isEnsemble {
                            if isExpanded {
                                compactModelPickerControl
                                pendingProviderPill
                                approvalControl
                            } else {
                                compactModelPickerControl
                                pendingProviderPill
                            }
                        }
                        Spacer(minLength: 4)
                        if canQueueCurrentPrompt {
                            queueButton
                        }
                        if !card.isEnsemble {
                            scheduleButton
                        }
                        contextDonutButton
                        primaryActionButton
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, shell.style == .chatgpt ? 4 : (compactHeight ? 4 : 7))
            } else {
                HStack(spacing: 8) {
                    // Idle/unfocused: the collapsed control row is gone, so surface a
                    // tiny picker pill in the input's top-left corner (the transcript
                    // keeps the reclaimed vertical space). Solo chats only — ensemble
                    // uses the roster, not this picker.
                    if !isExpanded && !card.isEnsemble {
                        compactModelPickerControl
                        pendingProviderPill
                    }
                    #if canImport(UIKit)
                        // Ensembles included: steer now carries attachments.
                        photosButton
                    #endif
                    if shell.effects.contains(.terminalCaret) {
                        Text(">")
                            .font(twComposerFont(.monospaced).weight(.bold))
                            .foregroundStyle(shell.sendButton.tint)
                    }
                    composerTextInput
                    if canQueueCurrentPrompt {
                        queueButton
                    }
                    if !card.isEnsemble {
                        scheduleButton
                    }
                    contextDonutButton
                    primaryActionButton
                }
                .padding(.horizontal, 10)
                // CS14 chatgpt: tighter row inset — the flat pill reads capsule,
                // not sausage; every other shell keeps the shipped 8pt.
                .padding(.vertical, shell.style == .chatgpt ? 4 : (compactHeight ? 4 : 8))
            }
        }
        .padding(.horizontal, foldsControlsIntoInput ? 10 : 12)
        .padding(
            .vertical,
            shell.style == .chatgpt
                ? 4 : (compactHeight ? 3 : (foldsControlsIntoInput ? 7 : 9)))
        .background(composerBodyBackground)
        // CS12: input-owning shells (claude bubble / gemini-cursor capsule /
        // obsidian-alabaster rect) frame ONLY the input here; the footer is bare.
        .composerShellIf(shell.layout.inputOwnsSurface, shell)
    }

    @ViewBuilder
    private var contextDonutButton: some View {
        if let pct = contextUsedPercent {
            Button {
                showContextMeter = true
            } label: {
                ContextDonut(percent: pct, color: shell.palette.textPrimary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Context usage")
            .accessibilityValue("\(Int(pct.rounded())) percent used")
            .popover(isPresented: $showContextMeter) {
                ContextMeterPopoverBody(
                    rows: contextMeterRows, ensemble: contextMeterIsEnsemble
                )
                .frame(width: 280)
                .padding(12)
                .background(TWTheme.surface2)
                .presentationCompactAdaptation(.popover)
            }
        }
    }

    private var queueButton: some View {
        Button {
            queueCurrent()
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "tray.and.arrow.down")
                    .font(.system(size: 11, weight: .semibold))
                Text("Queue")
                    .font(.caption2.weight(.semibold))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(TWTheme.statusAttention.opacity(0.14), in: Capsule())
            .overlay(Capsule().strokeBorder(TWTheme.statusAttention.opacity(0.35)))
            .foregroundStyle(TWTheme.statusAttention)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Queue message")
        .accessibilityHint("Queues this message behind the active run.")
    }

    private var scheduleButton: some View {
        Button {
            showScheduleSheet = true
        } label: {
            Image(systemName: "clock")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(canScheduleFromThisComposer ? TWTheme.textSecondary : TWTheme.textMuted)
                .frame(width: 30, height: 30)
                .background(TWTheme.surface3.opacity(0.7), in: Circle())
                .overlay(Circle().strokeBorder(TWTheme.border.opacity(0.7)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!canScheduleFromThisComposer)
        .accessibilityLabel("Schedule message")
        .accessibilityHint(
            providerUnavailableReason ?? "Opens scheduling options for this message.")
    }

    /// Context-window fill for the donut left of the send button — the phone
    /// port of the desktop ContextWheel. `nil` until the thread has real token
    /// usage (the ring only surfaces once a run has consumed context), so a
    /// fresh composer stays clean. Window size comes from the model-id →
    /// provider-fallback table; usage is the latest run summary's total tokens.
    private var contextUsedPercent: Double? {
        // Ensemble: the donut reflects the per-participant rows — the participant
        // CLOSEST to its own window (max %), so the ring agrees with the popover.
        // NOT the round-summed runSummary ÷ one window (which sums multiple models
        // against a single window and over-reports).
        if card.isEnsemble {
            return contextMeterRows.map(\.percent).filter { $0 > 0 }.max()
        }
        // Solo: the LATEST run's input+output (each turn re-sends the whole
        // conversation, so the most recent run ≈ what's actually in the window),
        // NOT the cumulative sum across runs. Mirrors the desktop contextMeter.
        guard let snapshot = model.threadSnapshots[card.id] else { return nil }
        let summaries = snapshot.runSummaries ?? [snapshot.runSummary].compactMap { $0 }
        guard let active = snapshot.runSummary ?? summaries.last else { return nil }
        let used = active.totalTokens ?? ((active.tokensIn ?? 0) + (active.tokensOut ?? 0))
        guard used > 0 else { return nil }
        let window = ContextWindows.resolve(
            provider: active.provider ?? card.provider, model: active.model)
        guard window > 0 else { return nil }
        return min(100, Double(used) / Double(window) * 100)
    }

    /// Ensemble chats with a projected roster show per-participant context rows.
    private var contextMeterIsEnsemble: Bool {
        card.isEnsemble && !(model.ensembleStates[card.id]?.roster?.isEmpty ?? true)
    }

    /// Rows for the context-donut popover: one per ensemble participant (from the
    /// Mac-projected roster.contextTokens), or a single solo row from the latest
    /// run summary. Honest current-context (latest turn), matching the donut.
    private var contextMeterRows: [ContextMeterRowVM] {
        if contextMeterIsEnsemble, let roster = model.ensembleStates[card.id]?.roster {
            return roster
                .sorted(by: RemoteEnsembleState.rosterEntryOrder)
                .map { entry in
                    let providerName = TWTheme.providerLabel(entry.provider)
                    let role = entry.role?.trimmingCharacters(in: .whitespaces) ?? ""
                    var detailParts = [providerName]
                    if let modelId = entry.model, !modelId.isEmpty { detailParts.append(modelId) }
                    return ContextMeterRowVM(
                        id: entry.id,
                        primary: role.isEmpty ? providerName : role,
                        detail: detailParts.joined(separator: " · "),
                        provider: entry.provider,
                        model: entry.model,
                        usedTokens: entry.contextTokens ?? 0,
                        windowTokens: ContextWindows.resolve(
                            provider: entry.provider, model: entry.model))
                }
        }
        // Solo only — an ensemble without a projected roster shows nothing rather
        // than the misleading round-summed runSummary.
        guard !card.isEnsemble,
            let snapshot = model.threadSnapshots[card.id],
            let active = snapshot.runSummary ?? (snapshot.runSummaries ?? []).last
        else { return [] }
        let used = active.totalTokens ?? ((active.tokensIn ?? 0) + (active.tokensOut ?? 0))
        let providerStr = active.provider ?? card.provider ?? ""
        return [
            ContextMeterRowVM(
                id: "solo",
                primary: TWTheme.providerLabel(providerStr),
                detail: active.model ?? "",
                provider: providerStr,
                model: active.model,
                usedTokens: used,
                windowTokens: ContextWindows.resolve(provider: providerStr, model: active.model))
        ]
    }

    private var primaryActionButton: some View {
        let shell = twResolvedComposerShell(model: model)
        return Button {
            if isRunActive {
                model.cancelRun(card)
            } else {
                sendCurrent()
            }
        } label: {
            if shell.style == .defaultShell {
                // Signed-off native button — unchanged (default parity).
                Image(systemName: isRunActive ? "stop.circle.fill" : "arrow.up.circle.fill")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(primaryActionColor)
                    .frame(width: 38, height: 38)
                    .contentShape(Circle())
            } else {
                ComposerRecipeSendLabel(
                    shell: shell, isRunActive: isRunActive,
                    enabled: isRunActive ? canCancelRun : !sendDisabled)
            }
        }
        .disabled(isRunActive ? !canCancelRun : sendDisabled)
        .accessibilityLabel(isRunActive ? "Stop run" : "Send message")
        .accessibilityHint(
            isRunActive
                ? "Stops the active run."
                : (providerUnavailableReason ?? "Sends this message to the selected provider."))
    }

    private var primaryActionColor: Color {
        if isRunActive {
            return canCancelRun ? TWTheme.statusFailed : TWTheme.textMuted
        }
        // Neutral, theme-driven send affordance (white in dark themes, near-
        // black in light) instead of the provider accent / Ensemble violet —
        // the send action reads the same in every chat kind, with contrast
        // carried by the theme's primary text token.
        return sendDisabled ? TWTheme.textMuted : TWTheme.textPrimary
    }

    private var sendDisabled: Bool {
        #if canImport(UIKit)
            let emptyContent = isEmpty && attachments.isEmpty
        #else
            let emptyContent = isEmpty
        #endif
        if let workspaceId = newTaskWorkspaceId, workspaceId.isEmpty {
            return true
        }
        return emptyContent || !providerAdmission.isLive
    }

    private func insertMention(_ candidate: MentionCandidate) {
        guard let at = text.lastIndex(of: "@") else { return }
        text = String(text[..<at]) + candidate.insertText + " "
    }

    /// True when `modelId` is a real model for `provider` in the live catalog.
    /// When the catalog hasn't arrived yet we can't disprove validity, so we
    /// treat it as valid rather than dropping a legitimate saved selection
    /// during the catalog-load window.
    private func isModelValidForProvider(_ modelId: String, provider: String) -> Bool {
        let key = provider.lowercased()
        guard let models = model.providerModels[key] ?? model.providerModels[provider],
            !models.isEmpty
        else { return true }
        return models.contains { $0.id == modelId }
    }

    /// The model the picker should show for the loaded thread, mirroring the
    /// desktop precedence (App.tsx `getChatComposerSelection`): the thread's
    /// saved pick only when it's a valid model for this provider (custom models
    /// are always honored), else the thread's actual last-run model, else nil
    /// (→ catalog default). A stale / cross-provider `selectedModelType` no
    /// longer masks the model the thread actually ran with.
    private func resolvedThreadModelId() -> String? {
        let provider = card.provider ?? selectedProvider
        if nonEmpty(card.selectedModelType) == "custom" {
            return nonEmpty(card.customModel) ?? runModel
        }
        if let saved = cardSelectedModelId, isModelValidForProvider(saved, provider: provider) {
            return saved
        }
        return runModel
    }

    /// Re-bind the picker state to the currently loaded thread. Idempotent and
    /// safe to run on first appear and on every thread change.
    private func resyncPickerToThread() {
        selectedProvider = card.provider ?? selectedProvider
        selectedModelId = resolvedThreadModelId()
        selectedReasoningEffort = cardReasoningEffort
        selectedFastMode = cardFastMode
        selectedKimiThinking = cardKimiThinking
        providerEcho?.wrappedValue = selectedProvider
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
            !trimmed.isEmpty
        else { return nil }
        return trimmed
    }

    #if canImport(UIKit)
        /// Photo attach — solo chats only: ensemble sends ride ensembleSteer,
        /// which carries text alone, so showing the picker there silently
        /// dropped images.
        private var photosButton: some View {
            let remainingSlots = max(0, twMaxComposerImageAttachments - attachments.count)
            let attachmentLimitReached = remainingSlots == 0
            let iconColor = attachmentLimitReached ? TWTheme.textMuted : TWTheme.textSecondary
            return PhotosPicker(
                selection: $pickedItems, maxSelectionCount: max(1, remainingSlots), matching: .images
            ) {
                Image(systemName: "photo.badge.plus")
                    .font(.body)
                    .foregroundStyle(iconColor)
            }
            .disabled(attachmentLimitReached)
            .accessibilityLabel("Add photo attachment")
            .accessibilityHint(
                attachmentLimitReached
                    ? "Attachment limit reached. Maximum \(twMaxComposerImageAttachments) images."
                    : "Opens the photo picker to attach images to your message.")
            .accessibilityValue(
                "\(attachments.count) of \(twMaxComposerImageAttachments) images attached")
            .onChange(of: pickedItems) { _, items in
                guard !items.isEmpty else { return }
                Task {
                    for item in items {
                        guard attachments.count < twMaxComposerImageAttachments,
                            let data = try? await item.loadTransferable(type: Data.self),
                            let image = UIImage(data: data)
                        else { continue }
                        attachments.append((name: "photo.jpg", image: image))
                    }
                    pickedItems = []
                }
            }
        }
    #endif

    private func sendCurrent() {
        guard providerAdmission.isLive else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        #if canImport(UIKit)
            let encoded = attachments.prefix(twMaxComposerImageAttachments).compactMap {
                twEncodeImageAttachment($0.image, name: $0.name)
            }
            let hasAttachments = !encoded.isEmpty
        #else
            let hasAttachments = false
        #endif
        guard !trimmed.isEmpty || hasAttachments else { return }

        if let workspaceId = newTaskWorkspaceId, !workspaceId.isEmpty {
            #if canImport(UIKit)
                model.startTask(
                    workspaceId: workspaceId, provider: selectedProvider, prompt: trimmed,
                    model: selectedModelId,
                    approvalMode: bridgeApprovalMode,
                    workflowMode: bridgeWorkflowMode,
                    permissionPresetId: bridgePermissionPresetId,
                    reasoningEffort: selectedReasoningEffort,
                    imageAttachments: hasAttachments ? encoded : nil,
                    fastModeEnabled: selectedFastMode, kimiThinkingEnabled: effectiveKimiThinking)
                attachments = []
            #else
                model.startTask(
                    workspaceId: workspaceId, provider: selectedProvider, prompt: trimmed,
                    model: selectedModelId,
                    approvalMode: bridgeApprovalMode,
                    workflowMode: bridgeWorkflowMode,
                    permissionPresetId: bridgePermissionPresetId,
                    reasoningEffort: selectedReasoningEffort,
                    fastModeEnabled: selectedFastMode, kimiThinkingEnabled: effectiveKimiThinking)
            #endif
            text = ""
            return
        }

        let submittedText = text
        #if canImport(UIKit)
            let submittedAttachments = attachments
            text = ""
            attachments = []
            model.continueTask(
                card, prompt: submittedText,
                approvalMode: bridgeApprovalMode,
                workflowMode: bridgeWorkflowMode,
                permissionPresetId: bridgePermissionPresetId,
                model: selectedModelId,
                providerOverride: canChangeProvider ? selectedProvider : nil,
                reasoningEffort: selectedReasoningEffort,
                imageAttachments: encoded.isEmpty ? nil : encoded,
                extraWorkspaceIds: extraWorkspaceIds,
                fastModeEnabled: selectedFastMode, kimiThinkingEnabled: effectiveKimiThinking,
                navigateOnAck: navigateOnSend,
                onActionUnsent: {
                    if !submittedText.isEmpty {
                        text = text.isEmpty ? submittedText : submittedText + "\n\n" + text
                    }
                    if !submittedAttachments.isEmpty {
                        attachments = Array(
                            (submittedAttachments + attachments)
                                .prefix(twMaxComposerImageAttachments))
                    }
                })
        #else
            text = ""
            model.continueTask(
                card, prompt: submittedText,
                approvalMode: bridgeApprovalMode,
                workflowMode: bridgeWorkflowMode,
                permissionPresetId: bridgePermissionPresetId,
                model: selectedModelId,
                providerOverride: canChangeProvider ? selectedProvider : nil,
                reasoningEffort: selectedReasoningEffort,
                fastModeEnabled: selectedFastMode, kimiThinkingEnabled: effectiveKimiThinking,
                navigateOnAck: navigateOnSend,
                onActionUnsent: {
                    if !submittedText.isEmpty {
                        text = text.isEmpty ? submittedText : submittedText + "\n\n" + text
                    }
                })
        #endif
    }

    private func queueCurrent() {
        guard providerAdmission.isLive else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !hasImageAttachments else { return }
        if card.isEnsemble {
            model.queueEnsemblePrompt(card, prompt: trimmed)
        } else {
            model.queueComposerPrompt(
                card, prompt: trimmed,
                approvalMode: bridgeApprovalMode,
                workflowMode: bridgeWorkflowMode,
                permissionPresetId: bridgePermissionPresetId,
                model: selectedModelId,
                providerOverride: canChangeProvider ? selectedProvider : nil,
                reasoningEffort: selectedReasoningEffort,
                extraWorkspaceIds: extraWorkspaceIds,
                fastModeEnabled: selectedFastMode, kimiThinkingEnabled: effectiveKimiThinking)
        }
        text = ""
    }

    private func scheduleCurrent(runAt: Date) {
        guard providerAdmission.isLive else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !hasImageAttachments, canScheduleFromThisComposer else { return }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let scheduledRunAt = formatter.string(from: runAt)

        if let workspaceId = newTaskWorkspaceId, !workspaceId.isEmpty {
            model.startTask(
                workspaceId: workspaceId, provider: selectedProvider, prompt: trimmed,
                model: selectedModelId,
                approvalMode: bridgeApprovalMode,
                workflowMode: bridgeWorkflowMode,
                permissionPresetId: bridgePermissionPresetId,
                reasoningEffort: selectedReasoningEffort,
                fastModeEnabled: selectedFastMode, kimiThinkingEnabled: effectiveKimiThinking,
                scheduledRunAt: scheduledRunAt)
        } else {
            model.queueComposerPrompt(
                card, prompt: trimmed,
                approvalMode: bridgeApprovalMode,
                workflowMode: bridgeWorkflowMode,
                permissionPresetId: bridgePermissionPresetId,
                model: selectedModelId,
                providerOverride: canChangeProvider ? selectedProvider : nil,
                reasoningEffort: selectedReasoningEffort,
                extraWorkspaceIds: extraWorkspaceIds,
                fastModeEnabled: selectedFastMode, kimiThinkingEnabled: effectiveKimiThinking,
                scheduledRunAt: scheduledRunAt)
        }
        text = ""
    }

    private var placeholder: String {
        if card.isEnsemble {
            return "Ask the Ensemble"
        }
        return "Ask \(providerName) anything…"
    }
}
