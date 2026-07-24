// ComposerToolsPill — unfocused composer access to Ensemble / Goal / Plan /
// Blackboard. When the composer collapses to one line, the telemetry-rail
// icon controls hide; this pill (sibling of ComposerDiffPill) reopens them via
// a hierarchical NavigationStack picker.

import SwiftUI
import TaskWraithKit

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
    let onBlackboardPost: ((String, String, String) -> Void)?

    @State private var presented = false

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
        onBlackboardPost: ((String, String, String) -> Void)? = nil
    ) {
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
        Button {
            presented = true
        } label: {
            // Dedicated Ensemble / Goal / Plan / Blackboard glyphs — same icons as
            // the focused telemetry rail — rather than a generic "Tools" label.
            HStack(spacing: 8) {
                if ensembleToggleVisible {
                    ProviderGlyphIcon(
                        provider: "ensemble", isEnsemble: true, size: 14
                    )
                        .opacity(isEnsemble ? 1 : 0.55)
                        .frame(width: 16, height: 16)
                }

                ZStack(alignment: .topTrailing) {
                    Image(
                        systemName: activeGoal?.status == "completed"
                            ? "checkmark.circle.fill" : "scope"
                    )
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(goalAccent)
                    .frame(width: 16, height: 16)
                    if activeGoal?.status == "active" || activeGoal?.status == "paused"
                        || activeGoal?.status == "blocked"
                    {
                        Circle()
                            .fill(goalAccent)
                            .frame(width: 5, height: 5)
                            .offset(x: 2, y: -2)
                    }
                }

                ZStack(alignment: .topTrailing) {
                    Image(systemName: "checklist")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(planAccent)
                        .frame(width: 16, height: 16)
                    if planHasInProgress {
                        Circle()
                            .fill(planAccent)
                            .frame(width: 5, height: 5)
                            .offset(x: 2, y: -2)
                    }
                }

                if isEnsemble {
                    Image(systemName: "rectangle.and.pencil.and.ellipsis")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(
                            blackboardEntries.isEmpty ? TWTheme.textTertiary : TWTheme.chroma1
                        )
                        .frame(width: 16, height: 16)
                }
            }
            .composerFloatingPillChrome()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Composer tools. \(summaryLabel)")
        .accessibilityHint("Opens Ensemble, Goal, Plan, and Blackboard controls.")
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
                onBlackboardPost: onBlackboardPost
            )
            .twSheetLiquidGlass(detents: [.medium, .large])
        }
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
    let onBlackboardPost: ((String, String, String) -> Void)?

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
                        onPost: { value, category, scope in
                            onBlackboardPost?(value, category, scope)
                        })
                }
            }
        }
        .background(Color.clear)
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
    let onPost: (String, String, String) -> Void

    @State private var draft = ""
    @State private var category = "note"
    @State private var scope = "session"
    @State private var postTick = 0

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
                    Button {
                        guard !draftTrimmed.isEmpty else { return }
                        onPost(draftTrimmed, category, scope)
                        draft = ""
                        postTick += 1
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
}
