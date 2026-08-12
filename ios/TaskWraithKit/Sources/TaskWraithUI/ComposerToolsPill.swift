// ComposerToolsPill — unfocused composer access to Ensemble / Goal / Plan /
// Blackboard. When the composer collapses to one line, the telemetry-rail
// icon controls hide; this pill (sibling of ComposerDiffPill) reopens them via
// a hierarchical NavigationStack picker.

import SwiftUI
import TaskWraithKit

#if canImport(UIKit)
    import PhotosUI
    import UIKit
#endif

// MARK: - Pill
// Chrome lives on ComposerFloatingPillChrome (TWSharedViews) so Tools +
// Diff stay in lockstep: slightly taller padding + real liquid glass.

/// Compact floating tools pill (blurred composer). Icon-only chip using the
/// same Ensemble / Goal / Plan / Blackboard glyphs as the focused telemetry
/// rail; opens a hierarchical picker for those controls.
public struct ComposerToolsPill: View {
    let isEnsemble: Bool
    let ensembleToggleVisible: Bool
    let ensembleToggleDisabled: Bool
    let ensembleToggleTitle: String
    let activeGoal: RemoteActiveGoal?
    let planLanes: [RemoteTodoLane]
    let blackboardEntries: [RemoteThreadSnapshot.BlackboardEntry]
    let onEnsembleToggle: ((Bool) -> Void)?
    let onGoalUpdate: ((String, String?, String?) -> Void)?
    let onBlackboardPost: ((String, String, String, [[String: Any]]) -> Void)?
    let onBlackboardPollVote: ((String, String) -> Void)?
    /// Liquid Glass morph namespace shared with the sibling diff pill.
    var glassNamespace: Namespace.ID? = nil

    @State private var presented = false
    /// Section the picker opens on — set by whichever segment was tapped.
    @State private var selectedRoute: ComposerToolsRoute? = nil
    /// Segment taps are user-initiated discrete actions, so a selection haptic
    /// is within MotionHaptics' law here (unlike the diff pill's passive
    /// git updates, which stay visual-only).
    @State private var tapTick = 0

    public init(
        isEnsemble: Bool,
        ensembleToggleVisible: Bool,
        ensembleToggleDisabled: Bool = false,
        ensembleToggleTitle: String = "Ensemble",
        activeGoal: RemoteActiveGoal?,
        planLanes: [RemoteTodoLane] = [],
        blackboardEntries: [RemoteThreadSnapshot.BlackboardEntry] = [],
        onEnsembleToggle: ((Bool) -> Void)? = nil,
        onGoalUpdate: ((String, String?, String?) -> Void)? = nil,
        onBlackboardPost: ((String, String, String, [[String: Any]]) -> Void)? = nil,
        onBlackboardPollVote: ((String, String) -> Void)? = nil,
        glassNamespace: Namespace.ID? = nil
    ) {
        self.glassNamespace = glassNamespace
        self.isEnsemble = isEnsemble
        self.ensembleToggleVisible = ensembleToggleVisible
        self.ensembleToggleDisabled = ensembleToggleDisabled
        self.ensembleToggleTitle = ensembleToggleTitle
        self.activeGoal = activeGoal
        self.planLanes = planLanes
        self.blackboardEntries = blackboardEntries
        self.onEnsembleToggle = onEnsembleToggle
        self.onGoalUpdate = onGoalUpdate
        self.onBlackboardPost = onBlackboardPost
        self.onBlackboardPollVote = onBlackboardPollVote
    }

    private var summaryLabel: String {
        var parts: [String] = []
        if ensembleToggleVisible {
            parts.append(isEnsemble ? "Ensemble" : "Solo")
        }
        if let activeGoal {
            parts.append("Goal \(activeGoal.status)")
        } else {
            parts.append("Goal")
        }
        let planActive = planLanes.reduce(0) { $0 + $1.activeCount }
        let planDone = planLanes.reduce(0) { $0 + $1.completedCount }
        if planActive > 0 {
            parts.append("Plan \(planDone)/\(planActive)")
        } else {
            parts.append("Plan")
        }
        if isEnsemble {
            let n = blackboardEntries.count
            parts.append(n > 0 ? "Board \(n)" : "Board")
        }
        return parts.joined(separator: " · ")
    }

    public var body: some View {
        // Segmented, not one button: the diff pill beside this is a READOUT,
        // this is a CONTROL cluster, and identical chrome made them read as the
        // same kind of object. Each glyph is now its own target that lands on
        // its own section, so reaching Plan is one tap instead of tap-then-pick.
        HStack(spacing: 0) {
            if ensembleToggleVisible {
                segment(
                    .ensemble, label: ensembleToggleTitle,
                    value: isEnsemble ? "On" : "Off"
                ) {
                    // 1.2x the other glyphs' optical size (14 -> 16.8). The
                    // ensemble mark is a fine multi-arm spiral and read smaller
                    // than the solid SF glyphs beside it at matched sizes.
                    // Drawn at 16.8 but still handed the 16pt cell below, so it
                    // overflows by 0.4pt a side and the pill's own geometry —
                    // padding, height, divider spacing — is untouched.
                    ProviderGlyphIcon(provider: "ensemble", isEnsemble: true, size: 16.8)
                        .opacity(isEnsemble ? 1 : 0.55)
                }
                segmentDivider
            }

            segment(.goal, label: "Goal", value: goalSubtitleShort) {
                badged(dot: goalHasAttention ? goalAccent : nil) {
                    Image(
                        systemName: activeGoal?.status == "completed"
                            ? "checkmark.circle.fill" : "scope"
                    )
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(goalAccent)
                }
            }

            segmentDivider

            segment(.plan, label: "Plan", value: planSubtitleShort) {
                badged(dot: planHasInProgress ? planAccent : nil) {
                    Image(systemName: "checklist")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(planAccent)
                }
            }

            if isEnsemble {
                segmentDivider
                segment(
                    .blackboard, label: "Blackboard",
                    value: blackboardEntries.isEmpty
                        ? "Empty" : "\(blackboardEntries.count) entries"
                ) {
                    Image(systemName: "rectangle.and.pencil.and.ellipsis")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(
                            blackboardEntries.isEmpty ? TWTheme.textTertiary : TWTheme.chroma1
                        )
                }
            }
        }
        // Segments carry their own horizontal padding so the dividers can run
        // the full height of the chip rather than floating in a 12pt gutter.
        // interactive=false: the segmented Buttons provide their own press
        // feedback and haptics; leaving Liquid Glass `.interactive()` on the
        // wrapper swallows segment taps on iOS 26.
        .composerFloatingPillChrome(
            horizontalPadding: 4,
            glassID: glassNamespace == nil ? nil : "tw.composer.pill.tools",
            glassNamespace: glassNamespace,
            interactive: false
        )
        .motionHaptic(MotionHaptics.selection, trigger: tapTick)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Composer tools. \(summaryLabel)")
        .sheet(isPresented: $presented) {
            ComposerToolsPickerSheet(
                isEnsemble: isEnsemble,
                ensembleToggleVisible: ensembleToggleVisible,
                ensembleToggleDisabled: ensembleToggleDisabled,
                ensembleToggleTitle: ensembleToggleTitle,
                activeGoal: activeGoal,
                planLanes: planLanes,
                blackboardEntries: blackboardEntries,
                onEnsembleToggle: onEnsembleToggle,
                onGoalUpdate: onGoalUpdate,
                onBlackboardPost: onBlackboardPost,
                onBlackboardPollVote: onBlackboardPollVote,
                initialRoute: selectedRoute
            )
            .twSheetLiquidGlass(detents: [.medium, .large])
            // Scroll affordance: on short viewports (iPhone landscape, narrow
            // iPad aspects) the .medium detent can clip the Goal/Plan panels.
            // Prefer scrolling the sheet content over expanding the detent so
            // the drag indicator still communicates resizeability.
            .presentationContentInteraction(.scrolls)
        }
    }

    /// One tappable glyph. Opens the picker already pushed to `route`.
    @ViewBuilder
    private func segment(
        _ route: ComposerToolsRoute, label: String, value: String,
        @ViewBuilder content: () -> some View
    ) -> some View {
        Button {
            selectedRoute = route
            tapTick += 1
            presented = true
        } label: {
            content()
                .frame(width: 16, height: 16)
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                // Whole cell is the target, not just the glyph's alpha.
                .contentShape(Rectangle())
        }
        .buttonStyle(ComposerToolsSegmentStyle())
        .accessibilityLabel(label)
        .accessibilityValue(value)
        .accessibilityHint("Opens \(label) controls.")
    }

    /// Hairline rule between segments. Low alpha — it should separate, not
    /// draw attention to itself.
    private var segmentDivider: some View {
        Rectangle()
            .fill(Color.white.opacity(0.10))
            .frame(width: 0.5, height: 15)
            .accessibilityHidden(true)
    }

    /// Glyph plus the live-state dot, kept in one place so every segment's
    /// badge sits at the same offset.
    @ViewBuilder
    private func badged(dot: Color?, @ViewBuilder content: () -> some View) -> some View {
        ZStack(alignment: .topTrailing) {
            content().frame(width: 16, height: 16)
            if let dot {
                Circle()
                    .fill(dot)
                    .frame(width: 5, height: 5)
                    // Ring lifts the dot off a same-hue glyph underneath.
                    .overlay(Circle().strokeBorder(Color.black.opacity(0.35), lineWidth: 0.5))
                    .offset(x: 2, y: -2)
            }
        }
    }

    private var goalHasAttention: Bool {
        activeGoal?.status == "active" || activeGoal?.status == "paused"
            || activeGoal?.status == "blocked"
    }

    /// VoiceOver values — short, since the segment label already says what it is.
    private var goalSubtitleShort: String { activeGoal?.status ?? "None" }

    private var planSubtitleShort: String {
        let active = planLanes.reduce(0) { $0 + $1.activeCount }
        let done = planLanes.reduce(0) { $0 + $1.completedCount }
        return active > 0 ? "\(done) of \(active) done" : "None"
    }

    private var planHasInProgress: Bool {
        planLanes.contains { $0.currentStep?.isInProgress == true }
    }

    @MainActor
    private var goalAccent: Color {
        switch activeGoal?.status {
        case "active": return TWTheme.chroma1
        case "paused": return TWTheme.statusAttention
        case "blocked": return TWTheme.statusFailed
        case "completed": return TWTheme.statusSuccess
        default: return TWTheme.textTertiary
        }
    }

    @MainActor
    private var planAccent: Color {
        let active = planLanes.reduce(0) { $0 + $1.activeCount }
        let done = planLanes.reduce(0) { $0 + $1.completedCount }
        if planHasInProgress { return TWTheme.chroma1 }
        if active > 0 && done >= active { return TWTheme.statusSuccess }
        return TWTheme.textTertiary
    }
}

/// Press response for a tools segment. Scale + dim only — the chip's own
/// Liquid Glass already deforms under `.interactive()`, so anything heavier
/// here fights it.
private struct ComposerToolsSegmentStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.55 : 1)
            .scaleEffect(reduceMotion || !configuration.isPressed ? 1 : 0.9)
            .animation(
                reduceMotion
                    ? .easeOut(duration: 0.12)
                    : .spring(response: 0.24, dampingFraction: 0.7),
                value: configuration.isPressed)
    }
}

// MARK: - Hierarchical picker

private enum ComposerToolsRoute: Hashable {
    case ensemble
    case goal
    case plan
    case blackboard
}

private struct ComposerToolsPickerSheet: View {
    let isEnsemble: Bool
    let ensembleToggleVisible: Bool
    let ensembleToggleDisabled: Bool
    let ensembleToggleTitle: String
    let activeGoal: RemoteActiveGoal?
    let planLanes: [RemoteTodoLane]
    let blackboardEntries: [RemoteThreadSnapshot.BlackboardEntry]
    let onEnsembleToggle: ((Bool) -> Void)?
    let onGoalUpdate: ((String, String?, String?) -> Void)?
    let onBlackboardPost: ((String, String, String, [[String: Any]]) -> Void)?
    let onBlackboardPollVote: ((String, String) -> Void)?
    /// Section to push on open — set by the tools pill's tapped segment. Nil
    /// opens the root list (the old behaviour, still used by any caller that
    /// has no specific destination in mind).
    var initialRoute: ComposerToolsRoute? = nil

    @Environment(\.dismiss) private var dismiss
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    if ensembleToggleVisible {
                        NavigationLink(value: ComposerToolsRoute.ensemble) {
                            rootRow(
                                title: "Ensemble",
                                subtitle: isEnsemble ? "On" : "Off",
                                accent: isEnsemble ? TWTheme.chroma2 : TWTheme.textTertiary,
                                usesEnsembleGlyph: true)
                        }
                    }
                    NavigationLink(value: ComposerToolsRoute.goal) {
                        rootRow(
                            title: "Goal",
                            subtitle: goalSubtitle,
                            systemImage: activeGoal?.status == "completed"
                                ? "checkmark.circle.fill" : "scope",
                            accent: goalAccent)
                    }
                    NavigationLink(value: ComposerToolsRoute.plan) {
                        rootRow(
                            title: "Plan",
                            subtitle: planSubtitle,
                            systemImage: "checklist",
                            accent: planAccent)
                    }
                    if isEnsemble {
                        NavigationLink(value: ComposerToolsRoute.blackboard) {
                            rootRow(
                                title: "Blackboard",
                                subtitle: blackboardEntries.isEmpty
                                    ? "Empty"
                                    : "\(blackboardEntries.count) entries",
                                systemImage: "rectangle.and.pencil.and.ellipsis",
                                accent: TWTheme.chroma1)
                        }
                    }
                }
                .twGlassSheetRowBackground()
            }
            .twGlassSheetListCanvas()
            .background(Color.clear)
            .navigationTitle("Tools")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .navigationDestination(for: ComposerToolsRoute.self) { route in
                switch route {
                case .ensemble:
                    EnsembleToolsPanel(
                        enabled: isEnsemble,
                        disabled: ensembleToggleDisabled,
                        title: ensembleToggleTitle,
                        onSelect: { enabled in
                            onEnsembleToggle?(enabled)
                            dismiss()
                        })
                case .goal:
                    GoalToolsPanel(goal: activeGoal, onUpdate: { op, objective, reason in
                        onGoalUpdate?(op, objective, reason)
                    })
                case .plan:
                    PlanToolsPanel(lanes: planLanes)
                case .blackboard:
                    BlackboardToolsPanel(
                        entries: blackboardEntries,
                        canPost: onBlackboardPost != nil,
                        onPost: { value, category, scope, attachments in
                            onBlackboardPost?(value, category, scope, attachments)
                        },
                        onVote: onBlackboardPollVote)
                }
            }
        }
        .background(Color.clear)
        // Seed the destination ONCE, on first appear. Doing it in `init` isn't
        // possible for @State, and re-seeding on every appear would fight the
        // user's own back-navigation inside the sheet.
        .onAppear {
            if let initialRoute, path.isEmpty { path.append(initialRoute) }
        }
    }

    private var goalSubtitle: String {
        guard let activeGoal else { return "Not set" }
        return activeGoal.status.capitalized
    }

    private var planSubtitle: String {
        let active = planLanes.reduce(0) { $0 + $1.activeCount }
        let done = planLanes.reduce(0) { $0 + $1.completedCount }
        if active == 0 { return planLanes.isEmpty ? "No plan" : "Idle" }
        return "\(done)/\(active) done"
    }

    @MainActor
    private var goalAccent: Color {
        switch activeGoal?.status {
        case "active": return TWTheme.chroma1
        case "paused": return TWTheme.statusAttention
        case "blocked": return TWTheme.statusFailed
        case "completed": return TWTheme.statusSuccess
        default: return TWTheme.textTertiary
        }
    }

    @MainActor
    private var planAccent: Color {
        let hasInProgress = planLanes.contains { $0.currentStep?.isInProgress == true }
        let active = planLanes.reduce(0) { $0 + $1.activeCount }
        let done = planLanes.reduce(0) { $0 + $1.completedCount }
        if hasInProgress { return TWTheme.chroma1 }
        if active > 0 && done >= active { return TWTheme.statusSuccess }
        return TWTheme.textTertiary
    }

    @ViewBuilder
    private func rootRow(
        title: String, subtitle: String, systemImage: String? = nil, accent: Color,
        usesEnsembleGlyph: Bool = false
    ) -> some View {
        HStack(spacing: 12) {
            Group {
                if usesEnsembleGlyph {
                    ProviderGlyphIcon(
                        provider: "ensemble", isEnsemble: true, size: 18
                    )
                    .opacity(isEnsemble ? 1 : 0.55)
                } else if let systemImage {
                    Image(systemName: systemImage)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(accent)
                }
            }
                .frame(width: 28, height: 28)
                .background(accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 7))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(TWTheme.textSecondary)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Ensemble child

private struct EnsembleToolsPanel: View {
    let enabled: Bool
    let disabled: Bool
    let title: String
    let onSelect: (Bool) -> Void

    var body: some View {
        List {
            Group {
                Section {
                    Text(title)
                        .font(.caption)
                        .foregroundStyle(TWTheme.textSecondary)
                }
                Section {
                    Button {
                        onSelect(true)
                    } label: {
                        Label {
                            Text("Ensemble on")
                        } icon: {
                            Image(systemName: enabled ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(enabled ? TWTheme.chroma2 : TWTheme.textTertiary)
                        }
                    }
                    .disabled(disabled || enabled)

                    Button {
                        onSelect(false)
                    } label: {
                        Label {
                            Text("Ensemble off")
                        } icon: {
                            Image(systemName: !enabled ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(!enabled ? TWTheme.chroma1 : TWTheme.textTertiary)
                        }
                    }
                    .disabled(disabled || !enabled)
                } footer: {
                    if disabled {
                        Text("Finish the current turn first to change chat mode.")
                    } else {
                        Text("Turning Ensemble on seeds a multi-provider roster. Turning it off returns to a single-provider chat.")
                    }
                }
            }
            .twGlassSheetRowBackground()
        }
        .twGlassSheetListCanvas()
        .background(Color.clear)
        .navigationTitle("Ensemble")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

// MARK: - Goal child

private struct GoalToolsPanel: View {
    let goal: RemoteActiveGoal?
    let onUpdate: (String, String?, String?) -> Void

    @State private var editing = false
    @State private var draft = ""
    @State private var reason = ""

    private var status: String { goal?.status ?? "empty" }

    @MainActor
    private var accent: Color {
        switch goal?.status {
        case "active": return TWTheme.chroma1
        case "paused": return TWTheme.statusAttention
        case "blocked": return TWTheme.statusFailed
        case "completed": return TWTheme.statusSuccess
        default: return TWTheme.textTertiary
        }
    }

    private var modeLabel: String {
        switch goal?.mode {
        case "codex_native": return "Native Codex"
        case "claude_native": return "Native Claude"
        case "ollama_harness": return "Ollama managed"
        case "taskwraith_steered": return "Guided by TaskWraith"
        default: return "Goal"
        }
    }

    var body: some View {
        List {
            Group {
                Section {
                    HStack {
                        Text(goal == nil ? "No active goal" : "Active goal")
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Text(modeLabel)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(TWTheme.textSecondary)
                    }
                }

                if goal == nil || editing {
                    Section("Objective") {
                        TextEditor(text: $draft)
                            .font(.callout)
                            .frame(minHeight: 86)
                        HStack {
                            Button(goal == nil ? "Set goal" : "Save") {
                                let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                                guard !trimmed.isEmpty else { return }
                                onUpdate(goal == nil ? "set" : "edit", trimmed, nil)
                                editing = false
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            if goal != nil {
                                Button("Cancel") { editing = false }
                                    .buttonStyle(.bordered)
                            }
                        }
                    }
                } else if let goal {
                    Section {
                        Text(status.capitalized)
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(accent.opacity(0.14), in: Capsule())
                            .foregroundStyle(accent)
                        Text(goal.objective)
                            .font(.callout)
                            .foregroundStyle(TWTheme.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                        if let blockedReason = goal.blockedReason, !blockedReason.isEmpty {
                            Text(blockedReason)
                                .font(.caption)
                                .foregroundStyle(TWTheme.textSecondary)
                        }
                    }

                    Section("Reason (optional)") {
                        TextField("Reason", text: $reason)
                    }

                    Section("Actions") {
                        Button("Edit objective") {
                            draft = goal.objective
                            editing = true
                        }
                        if goal.status == "paused" || goal.status == "blocked" {
                            Button("Resume") { onUpdate("resume", nil, reasonOrNil) }
                        } else if goal.status != "completed" {
                            Button("Pause") { onUpdate("pause", nil, reasonOrNil) }
                        }
                        if goal.status != "completed" {
                            Button("Mark complete") { onUpdate("complete", nil, reasonOrNil) }
                        }
                        if goal.status != "blocked" && goal.status != "completed" {
                            Button("Block") {
                                onUpdate("block", nil, reason.isEmpty ? "Blocked from mobile." : reason)
                            }
                        }
                        Button("Clear goal", role: .destructive) { onUpdate("clear", nil, nil) }
                    }
                }
            }
            .twGlassSheetRowBackground()
        }
        .twGlassSheetListCanvas()
        .background(Color.clear)
        .navigationTitle("Goal")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .onAppear {
            if goal == nil {
                editing = true
                draft = ""
            }
        }
    }

    private var reasonOrNil: String? {
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

// MARK: - Plan child

private struct PlanToolsPanel: View {
    let lanes: [RemoteTodoLane]

    private var totalActive: Int { lanes.reduce(0) { $0 + $1.activeCount } }
    private var totalCompleted: Int { lanes.reduce(0) { $0 + $1.completedCount } }

    @MainActor
    private func statusIcon(_ item: RemoteTodoItem) -> (String, Color) {
        if item.isCompleted { return ("checkmark.circle.fill", TWTheme.statusSuccess) }
        if item.isInProgress { return ("circle.lefthalf.filled", TWTheme.chroma1) }
        if item.isCancelled { return ("xmark.circle", TWTheme.textTertiary) }
        return ("circle", TWTheme.textTertiary)
    }

    var body: some View {
        List {
            if lanes.isEmpty {
                ContentUnavailableView(
                    "No plan steps",
                    systemImage: "checklist",
                    description: Text("When agents post a working plan, steps appear here by participant.")
                )
            } else {
                Section {
                    if totalActive > 0 {
                        Text("\(totalCompleted)/\(totalActive) steps done")
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(TWTheme.textSecondary)
                    }
                }
                ForEach(lanes) { lane in
                    Section {
                        ForEach(lane.items) { item in
                            let (icon, color) = statusIcon(item)
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: icon)
                                    .font(.system(size: 12))
                                    .foregroundStyle(color)
                                    .frame(width: 16)
                                Text(item.content)
                                    .font(.callout)
                                    .foregroundStyle(
                                        item.isCompleted || item.isCancelled
                                            ? TWTheme.textSecondary : TWTheme.textPrimary
                                    )
                                    .strikethrough(item.isCancelled)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    } header: {
                        if !lane.isSolo && lanes.count > 1 {
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(TWTheme.providerAccent(lane.lane))
                                    .frame(width: 7, height: 7)
                                Text(TWTheme.providerLabel(lane.lane))
                                Spacer()
                                Text("\(lane.completedCount)/\(lane.activeCount)")
                                    .font(.caption2.monospacedDigit())
                            }
                        } else if lanes.count == 1 {
                            Text("Plan steps")
                        }
                    }
                }
            }
        }
        .twGlassSheetListCanvas()
        .background(Color.clear)
        .navigationTitle("Plan")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

// MARK: - Blackboard child

private struct BlackboardToolsPanel: View {
    let entries: [RemoteThreadSnapshot.BlackboardEntry]
    let canPost: Bool
    let onPost: (String, String, String, [[String: Any]]) -> Void
    var onVote: ((String, String) -> Void)? = nil

    @State private var draft = ""
    @State private var category = "note"
    @State private var scope = "session"
    @State private var postTick = 0
    /// Poll the user just voted on (optimistic tick until the Mac echoes).
    @State private var pendingVotePollId: String? = nil
    #if canImport(UIKit)
        @State private var pickedItems: [PhotosPickerItem] = []
        @State private var pickedImages: [(name: String, image: UIImage)] = []
    #endif

    private static let categoryOrder = ["decision", "fact", "risk", "do-not-repeat", "note"]
    private static let categoryLabels: [String: String] = [
        "decision": "Decisions",
        "fact": "Facts",
        "risk": "Risks",
        "do-not-repeat": "Do not repeat",
        "note": "Notes",
    ]
    private static let scopeLabels: [(id: String, label: String)] = [
        ("session", "Session"),
        ("chat", "Chat"),
        ("round", "Round"),
    ]

    private var visibleEntries: [RemoteThreadSnapshot.BlackboardEntry] {
        entries
            .filter { !$0.key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .filter { !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .sorted { lhs, rhs in
                let lhsRank = Self.categoryOrder.firstIndex(of: lhs.category) ?? Int.max
                let rhsRank = Self.categoryOrder.firstIndex(of: rhs.category) ?? Int.max
                if lhsRank != rhsRank { return lhsRank < rhsRank }
                return (lhs.createdAt ?? "") > (rhs.createdAt ?? "")
            }
    }

    private var draftTrimmed: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        List {
            if canPost {
                Section("Post a note") {
                    TextEditor(text: $draft)
                        .font(.callout)
                        .frame(minHeight: 72)
                    Picker("Category", selection: $category) {
                        ForEach(Self.categoryOrder, id: \.self) { key in
                            Text(Self.categoryLabels[key] ?? key).tag(key)
                        }
                    }
                    Picker("Scope", selection: $scope) {
                        ForEach(Self.scopeLabels, id: \.id) { item in
                            Text(item.label).tag(item.id)
                        }
                    }
                    #if canImport(UIKit)
                        PhotosPicker(
                            selection: $pickedItems, maxSelectionCount: 3, matching: .images
                        ) {
                            Label(
                                pickedImages.isEmpty
                                    ? "Attach images"
                                    : "\(pickedImages.count) image\(pickedImages.count == 1 ? "" : "s") attached",
                                systemImage: "photo.on.rectangle")
                                .font(.caption)
                        }
                        .onChange(of: pickedItems) { _, items in
                            Task {
                                var loaded: [(name: String, image: UIImage)] = []
                                for (index, item) in items.enumerated() {
                                    if let data = try? await item.loadTransferable(
                                        type: Data.self),
                                        let image = UIImage(data: data)
                                    {
                                        loaded.append((name: "blackboard-\(index + 1).jpg", image: image))
                                    }
                                }
                                pickedImages = loaded
                            }
                        }
                    #endif
                    Button {
                        guard !draftTrimmed.isEmpty else { return }
                        onPost(draftTrimmed, category, scope, attachmentPayloads())
                        draft = ""
                        postTick += 1
                        #if canImport(UIKit)
                            pickedItems = []
                            pickedImages = []
                        #endif
                    } label: {
                        Label("Post to Blackboard", systemImage: "paperplane.fill")
                    }
                    .disabled(draftTrimmed.isEmpty)
                }
            }

            if visibleEntries.isEmpty {
                Section {
                    Text("No blackboard entries yet.")
                        .font(.caption)
                        .foregroundStyle(TWTheme.textMuted)
                }
            } else {
                ForEach(Self.categoryOrder, id: \.self) { cat in
                    let group = visibleEntries.filter { $0.category == cat }
                    if !group.isEmpty {
                        Section(Self.categoryLabels[cat] ?? cat) {
                            ForEach(group) { entry in
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text(entry.key)
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(TWTheme.textPrimary)
                                        Spacer()
                                        Text(entry.scope.uppercased())
                                            .font(.system(size: 9, weight: .bold))
                                            .foregroundStyle(TWTheme.textMuted)
                                    }
                                    Text(entry.value)
                                        .font(.caption)
                                        .foregroundStyle(TWTheme.textSecondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                    if let images = entry.images, !images.isEmpty {
                                        BlackboardThumbnailGrid(images: images)
                                    }
                                    if let poll = entry.poll {
                                        blackboardPollRows(entry: entry, poll: poll)
                                    }
                                    if let participant = entry.participantId, !participant.isEmpty {
                                        Text(participant)
                                            .font(.caption2)
                                            .foregroundStyle(TWTheme.textMuted)
                                    }
                                }
                                .padding(.vertical, 2)
                            }
                        }
                    }
                }
            }
        }
        .twGlassSheetListCanvas()
        .navigationTitle("Blackboard")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .motionHaptic(MotionHaptics.success, trigger: postTick)
    }

    /// One tappable row per option: tally share, count, and the user's own
    /// standing vote ticked. The phone could WATCH a vote before this; now it
    /// casts one — desktop BlackboardPollControls parity, list-idiom sized.
    @ViewBuilder
    private func blackboardPollRows(
        entry: RemoteThreadSnapshot.BlackboardEntry,
        poll: RemoteThreadSnapshot.BlackboardEntry.Poll
    ) -> some View {
        let votes = poll.votes ?? []
        let canVote = onVote != nil && poll.userVotable != false
        VStack(alignment: .leading, spacing: 4) {
            ForEach(poll.options, id: \.self) { option in
                let optionVotes = votes.filter { $0.choice == option }.count
                let chosen = poll.userChoice == option
                Button {
                    guard canVote, !chosen else { return }
                    pendingVotePollId = entry.id
                    onVote?(entry.id, option)
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(chosen ? TWTheme.statusSuccess : TWTheme.textMuted)
                        Text(option)
                            .font(.caption)
                            .foregroundStyle(TWTheme.textPrimary)
                            .lineLimit(2)
                        Spacer(minLength: 4)
                        Text("\(optionVotes)")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(TWTheme.textSecondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!canVote)
                .accessibilityLabel(
                    "Vote \(option), \(optionVotes) vote\(optionVotes == 1 ? "" : "s")\(chosen ? ", your vote" : "")"
                )
            }
            if pendingVotePollId == entry.id && canVote {
                Text("Sending vote…")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textMuted)
            }
        }
        .padding(.top, 2)
    }

    #if canImport(UIKit)
        private func attachmentPayloads() -> [[String: Any]] {
            pickedImages.compactMap { attachment in
                guard let data = attachment.image.jpegData(compressionQuality: 0.8) else {
                    return nil
                }
                return [
                    "name": attachment.name,
                    "mimeType": "image/jpeg",
                    "dataBase64": data.base64EncodedString(),
                ]
            }
        }
    #else
        private func attachmentPayloads() -> [[String: Any]] { [] }
    #endif
}
