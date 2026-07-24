// RosterParticipantPopover — the compact anchored participant editor.
//
// Electron `EnsembleParticipantOverflowPopover` parity at iOS glass-picker
// density: tapping a roster row or strip chip opens a small anchored glass
// popover (Enabled pill, Boss/Captain/Agent segments, Stage segments, Role
// preset + custom field, Goal/Brief editor) instead of the old full-height
// `RosterChipEditor` sheet. Because iOS has no per-chip composer pickers
// below the popover (the desktop's hint points there), the editor carries
// two extra compact rows: the combined Provider·Model picker and the
// Permission preset.
//
// The add flow mirrors Electron's add-participant popover exactly: the same
// fields cluster stacked ABOVE the combined model list + reasoning ladder
// (`ProviderModelPickerPanel` topContent) with an `Add` confirm in the
// sidecar — replacing the old provider Menu → seed → editor-sheet two-step.
//
// Commit model (desktop parity): discrete controls apply immediately via
// `onApply`; the free-typed Role/Brief drafts flush on close (`onDisappear`)
// so a keystroke never round-trips the roster bridge.

import SwiftUI
import TaskWraithKit

// MARK: - Role presets (Electron ensembleRolePresets.ts port)

struct TWEnsembleRolePreset: Identifiable, Equatable {
    let id: String
    let label: String
    let description: String
}

let twEnsembleRolePresetCustomId = "custom"

/// Static mirror of the desktop's `ENSEMBLE_ROLE_PRESETS`. Labels are the
/// stored role strings; ids are stable preset keys for the picker only.
let twEnsembleRolePresets: [TWEnsembleRolePreset] = [
    .init(id: "explorer", label: "Explorer", description: "Map the problem, constraints, and safest path"),
    .init(id: "architect", label: "Architect", description: "Shape structure, interfaces, and tradeoffs"),
    .init(
        id: "designer", label: "Designer",
        description:
            "Protect UI/UX quality: extend existing chrome, hierarchy, and interaction patterns while making clear design calls"
    ),
    .init(id: "planner", label: "Planner", description: "Break work into ordered, reviewable steps"),
    .init(id: "worker", label: "Worker", description: "Execute implementation and concrete changes"),
    .init(id: "implementer", label: "Implementer", description: "Land the patch with tight, tested diffs"),
    .init(id: "reviewer", label: "Reviewer", description: "Critique quality, risks, and missing cases"),
    .init(id: "debugger", label: "Debugger", description: "Trace failures and isolate root causes"),
    .init(id: "researcher", label: "Researcher", description: "Gather facts, references, and alternatives"),
    .init(id: "synthesizer", label: "Synthesizer", description: "Merge peer outputs into a coherent answer"),
    .init(id: "documentarian", label: "Documentarian", description: "Capture decisions, usage, and handoff notes"),
    .init(id: "tester", label: "Tester", description: "Design checks, repro steps, and verification"),
]

func twResolveRolePresetId(_ role: String) -> String {
    let normalized = role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !normalized.isEmpty else { return twEnsembleRolePresetCustomId }
    return twEnsembleRolePresets.first { $0.label.lowercased() == normalized }?.id
        ?? twEnsembleRolePresetCustomId
}

// MARK: - Compact building blocks (desktop PillButton / SegmentedControl twins)

/// Small stateful pill — the desktop popover's compact `PillButton`
/// (aria-pressed) twin. On = tinted fill; off = hairline outline.
struct TWCompactPillToggle: View {
    let label: String
    let isOn: Bool
    var tint: Color = TWTheme.chroma1
    var disabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(isOn ? Color.white : TWTheme.textSecondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(Capsule().fill(isOn ? tint : Color.clear))
                .overlay(
                    Capsule().strokeBorder(
                        isOn ? Color.clear : TWTheme.border, lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.45 : 1)
        .accessibilityLabel(label)
        .accessibilityValue(isOn ? "On" : "Off")
        .accessibilityAddTraits(isOn ? [.isSelected] : [])
    }
}

/// One option of the compact segmented control.
struct TWCompactSegmentOption: Identifiable, Equatable {
    let value: String
    let label: String
    var systemImage: String? = nil
    /// Selected-state text/icon tint (Boss gold, Captain blue); default accent.
    var tint: Color? = nil
    var disabled: Bool = false
    var help: String? = nil
    var id: String { value }
}

/// Custom compact segmented control matching the glass-popover density —
/// the desktop popover's `SegmentedControl size="compact"` twin. Custom (not
/// a native segmented `Picker`) so segments can carry tinted SF Symbol icons
/// (crown/shield) exactly like the desktop's Boss/Captain segments.
struct TWCompactSegmented: View {
    let options: [TWCompactSegmentOption]
    @Binding var selection: String
    var accessibilityLabelText: String = "Options"

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options) { option in
                segment(option)
            }
        }
        .padding(2)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(TWTheme.surface3.opacity(0.55)))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(TWTheme.border, lineWidth: 0.5))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabelText)
    }

    @ViewBuilder
    private func segment(_ option: TWCompactSegmentOption) -> some View {
        let selected = option.value == selection
        let tint = option.tint ?? TWTheme.textPrimary
        Button {
            guard !option.disabled, !selected else { return }
            selection = option.value
        } label: {
            HStack(spacing: 3) {
                if let systemImage = option.systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 9, weight: .semibold))
                }
                Text(option.label)
                    .font(.system(size: 10.5, weight: selected ? .semibold : .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .foregroundStyle(
                selected ? tint : option.disabled ? TWTheme.textMuted : TWTheme.textSecondary
            )
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(selected ? TWTheme.surface1 : Color.clear))
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(
                        selected ? TWTheme.border : Color.clear, lineWidth: 0.5))
            .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(option.disabled)
        .opacity(option.disabled ? 0.5 : 1)
        .accessibilityLabel(option.label)
        .accessibilityHint(option.help ?? "")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

/// Uppercase micro section label — the desktop `.ensemble-above-overflow-label`.
struct TWPopoverFieldLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .textCase(.uppercase)
            .foregroundStyle(TWTheme.textSecondary)
    }
}

// MARK: - Shared fields cluster (authority + stage + role + brief)

/// The desktop popover's field stack, shared verbatim between the participant
/// editor popover and the add-participant popover (Electron shares
/// `EnsembleParticipantAuthorityControls` / `StageControl` / role / brief the
/// same way). Operates directly on a `RosterDraftEntry` binding; discrete
/// changes ping `onDiscreteChange` so the editor host can live-commit.
struct RosterParticipantFieldsCluster: View {
    @Binding var entry: RemoteSessionModel.RosterDraftEntry
    /// Fired after every tap-sized change (pills/segments/preset picks) —
    /// NOT after each keystroke; text flushes on close via the host.
    var onDiscreteChange: () -> Void = {}

    @State private var rolePresetId: String = twEnsembleRolePresetCustomId

    private var authoritySelection: Binding<String> {
        Binding(
            get: {
                entry.isBossman ? "boss" : entry.isSecondInCommand ? "captain" : "agent"
            },
            set: { value in
                entry.isBossman = value == "boss"
                entry.isSecondInCommand = value == "captain"
                onDiscreteChange()
            }
        )
    }

    /// "any" = no stage (permission-inferred scheduling) — stored nil.
    private var stageSelection: Binding<String> {
        Binding(
            get: { entry.stageRole ?? "any" },
            set: { value in
                entry.stageRole = value == "any" ? nil : value
                if value == "background" {
                    // BG seats cannot own Boss/Captain authority (desktop rule).
                    entry.isBossman = false
                    entry.isSecondInCommand = false
                }
                onDiscreteChange()
            }
        )
    }

    private var backgroundRestricted: Bool { entry.stageRole == "background" }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 6) {
                TWCompactPillToggle(
                    label: "Enabled",
                    isOn: entry.enabled,
                    tint: TWTheme.providerAccent(entry.provider, modelId: entry.model)
                ) {
                    entry.enabled.toggle()
                    onDiscreteChange()
                }
                Spacer(minLength: 0)
            }

            TWCompactSegmented(
                options: [
                    TWCompactSegmentOption(
                        value: "boss", label: "Boss", systemImage: "crown.fill",
                        tint: TWTheme.bossCrown, disabled: backgroundRestricted,
                        help: backgroundRestricted
                            ? "BG seats cannot own Boss or Captain authority."
                            : "Assign as the thread's only Boss."),
                    TWCompactSegmentOption(
                        value: "captain", label: "Captain", systemImage: "shield.fill",
                        tint: TWTheme.chroma3, disabled: backgroundRestricted,
                        help: backgroundRestricted
                            ? "BG seats cannot own Boss or Captain authority."
                            : "Assign as the thread's only Captain."),
                    TWCompactSegmentOption(
                        value: "agent", label: "Agent",
                        help: "Use standard Agent authority."),
                ],
                selection: authoritySelection,
                accessibilityLabelText: "Authority role"
            )

            VStack(alignment: .leading, spacing: 4) {
                TWPopoverFieldLabel(text: "Stage")
                TWCompactSegmented(
                    options: [
                        TWCompactSegmentOption(
                            value: "any", label: "Any",
                            help: "Schedule purely by permissions."),
                        TWCompactSegmentOption(
                            value: "scout", label: "Scout",
                            help: "Joins the parallel read-only pass at round start."),
                        TWCompactSegmentOption(
                            value: "worker", label: "Work",
                            help: "Always takes a serial implementation turn."),
                        TWCompactSegmentOption(
                            value: "reviewer", label: "Review",
                            help: "Runs after every non-reviewer finishes."),
                        TWCompactSegmentOption(
                            value: "background", label: "BG",
                            help: "Runs asynchronously only when explicitly delegated."),
                    ],
                    selection: stageSelection,
                    accessibilityLabelText: "Fan-out stage"
                )
            }

            VStack(alignment: .leading, spacing: 4) {
                TWPopoverFieldLabel(text: "Role")
                Menu {
                    ForEach(twEnsembleRolePresets) { preset in
                        Button {
                            rolePresetId = preset.id
                            entry.role = preset.label
                            onDiscreteChange()
                        } label: {
                            if rolePresetId == preset.id {
                                Label(preset.label, systemImage: "checkmark")
                            } else {
                                Text(preset.label)
                            }
                        }
                    }
                    Button {
                        rolePresetId = twEnsembleRolePresetCustomId
                    } label: {
                        if rolePresetId == twEnsembleRolePresetCustomId {
                            Label("Custom…", systemImage: "checkmark")
                        } else {
                            Text("Custom…")
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(
                            rolePresetId == twEnsembleRolePresetCustomId
                                ? "Custom…"
                                : twEnsembleRolePresets.first { $0.id == rolePresetId }?.label
                                    ?? "Custom…"
                        )
                        .font(.caption)
                        .foregroundStyle(TWTheme.textPrimary)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 7, weight: .semibold))
                            .foregroundStyle(TWTheme.textMuted)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(TWTheme.surface3.opacity(0.55)))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(TWTheme.border, lineWidth: 0.5))
                    .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .accessibilityLabel("Role preset")
                if rolePresetId == twEnsembleRolePresetCustomId {
                    TextField(
                        "\(TWTheme.providerLabel(entry.provider)) role", text: $entry.role
                    )
                    .font(.caption)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(TWTheme.surface3.opacity(0.55)))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(TWTheme.border, lineWidth: 0.5))
                    .accessibilityLabel("Custom role name")
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                TWPopoverFieldLabel(text: "Goal / brief")
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $entry.brief)
                        .font(.footnote)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 68, maxHeight: 96)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 2)
                    if entry.brief.isEmpty {
                        Text("Optional focus for this participant's turns…")
                            .font(.footnote)
                            .foregroundStyle(TWTheme.textMuted)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 10)
                            .allowsHitTesting(false)
                    }
                }
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(TWTheme.surface3.opacity(0.55)))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(TWTheme.border, lineWidth: 0.5))
                .accessibilityLabel("Goal or brief")
            }
        }
        .onAppear { rolePresetId = twResolveRolePresetId(entry.role) }
        .onChange(of: entry.id) { _, _ in
            rolePresetId = twResolveRolePresetId(entry.role)
        }
    }
}

// MARK: - Shared config column (fields, optional remove)

/// The shared topContent column both participant popovers stack above the
/// combined model list: the desktop fields cluster and — for the editor —
/// a compact destructive Remove row. (Permission lives in the sidecar's
/// compact picker, participant-scoped next to reasoning + Fast.) Ends in a
/// hairline so the provider sections below read as the same continuous panel.
private struct RosterParticipantConfigFields: View {
    @Binding var entry: RemoteSessionModel.RosterDraftEntry
    var onDiscreteChange: () -> Void = {}
    /// Present = editor mode; shows the Remove row.
    var onRemove: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 9) {
                RosterParticipantFieldsCluster(
                    entry: $entry, onDiscreteChange: onDiscreteChange)

                if let onRemove {
                    Button(role: .destructive, action: onRemove) {
                        Label("Remove participant", systemImage: "trash")
                            .font(.caption)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(TWTheme.statusFailed)
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)
            Rectangle()
                .fill(TWTheme.border)
                .frame(height: 0.5)
                .padding(.top, 10)
        }
    }
}

// MARK: - Sidecar permission picker (compact, participant-scoped)

/// Compact permission control for the participant popovers' sidecar: a small
/// shield trigger showing the current tier that opens a nested anchored glass
/// panel with the preset rows — same Liquid Glass language as the picker
/// itself, keeping permissions participant-scoped without a full field row.
struct RosterPermissionSidecarPicker: View {
    /// nil = "default" (Default approval).
    @Binding var permissionPresetId: String?
    var accent: Color = TWTheme.chroma1
    var onChanged: () -> Void = {}

    @State private var isPresented = false

    // Desktop permission colour-coding (08-theme-picker-overrides.css,
    // shell-agnostic block): Plan / Read-only → blue, Default → neutral,
    // Workspace Write → amber, Full access → dark red. The selected
    // checkmark and the closed trigger adopt the same tier tint so the
    // colour identity reads across closed + open states.
    private static let tierBlue = Color(hex: 0x6FB6FF)
    private static let tierAmber = Color(hex: 0xF59E0B)
    private static let tierRed = Color(hex: 0xDC2626)

    private struct Tier: Identifiable {
        let id: String
        let short: String
        let label: String
        let systemImage: String
        /// nil = neutral (Default approval keeps the untinted palette).
        var tint: Color? = nil
    }

    private static let tiers: [Tier] = [
        Tier(
            id: "read_only", short: "Read", label: "Read-Only/Recon",
            systemImage: "lock.shield", tint: tierBlue),
        Tier(
            id: "plan", short: "Plan", label: "Plan workflow",
            systemImage: "list.clipboard", tint: tierBlue),
        Tier(
            id: "default", short: "Ask", label: "Default approval",
            systemImage: "checkmark.shield"),
        Tier(
            id: "full_access", short: "Full", label: "Full access",
            systemImage: "bolt.shield", tint: tierRed),
    ]

    private static let legacyWorkspaceWrite = Tier(
        id: "workspace_write", short: "Write", label: "Workspace write (legacy)",
        systemImage: "pencil.and.outline", tint: tierAmber)

    private var selectedId: String { permissionPresetId ?? "default" }

    private var selectedTier: Tier {
        Self.tiers.first { $0.id == selectedId } ?? Self.legacyWorkspaceWrite
    }

    var body: some View {
        Button {
            isPresented = true
        } label: {
            VStack(spacing: 1) {
                Image(systemName: selectedTier.systemImage)
                    .font(.system(size: 10, weight: .semibold))
                Text(selectedTier.short)
                    .font(.system(size: 9, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .foregroundStyle(selectedTier.tint ?? TWTheme.textSecondary)
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(TWTheme.surface3.opacity(0.55)))
            .overlay(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .strokeBorder(
                        selectedTier.tint.map { $0.opacity(0.45) } ?? TWTheme.border,
                        lineWidth: selectedTier.tint == nil ? 0.5 : 1))
            .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Permission preset")
        .accessibilityValue(selectedTier.label)
        .popover(isPresented: $isPresented) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Image(systemName: "shield.lefthalf.filled")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(accent)
                    Text("Permissions")
                        .font(.system(size: 10, weight: .semibold))
                        .textCase(.uppercase)
                        .foregroundStyle(TWTheme.textSecondary)
                    Spacer()
                }
                .padding(.horizontal, 10)
                .padding(.top, 8)
                .padding(.bottom, 3)
                ForEach(Self.tiers) { tier in
                    tierRow(tier)
                }
                // 'Workspace write' (contained auto-edit) was coalesced into
                // Full access on iOS. A participant already stored on it keeps
                // showing its real value — never silently escalated — and can
                // switch to a tier above. New selections use the four tiers.
                if permissionPresetId == "workspace_write" {
                    tierRow(Self.legacyWorkspaceWrite)
                }
            }
            // Inset the rows from the glass edge so the panel's rounded
            // corners never sweep the first/last row's text.
            .padding(.horizontal, 5)
            .padding(.bottom, 8)
            .frame(width: 200)
            .twPickerGlassSurface(cornerRadius: 12)
            .presentationCompactAdaptation(.popover)
            .presentationBackground(.clear)
        }
    }

    @ViewBuilder
    private func tierRow(_ tier: Tier) -> some View {
        let selected = tier.id == selectedId
        Button {
            // Store the literal tier id — including "default" — so the bridge
            // SENDS it and the Mac applies a downgrade (a nil would be omitted
            // from the roster update and the old preset would survive).
            permissionPresetId = tier.id
            onChanged()
            isPresented = false
        } label: {
            HStack(spacing: 6) {
                Image(systemName: tier.systemImage)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(tier.tint ?? TWTheme.textSecondary)
                    .frame(width: 14)
                Text(tier.label)
                    .font(.caption)
                    .foregroundStyle(tier.tint ?? TWTheme.textPrimary)
                    .lineLimit(1)
                Spacer()
                if selected {
                    Image(systemName: "checkmark")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(tier.tint ?? TWTheme.textPrimary)
                }
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Participant editor popover

/// Compact anchored editor for ONE existing participant. IDENTICAL layout to
/// the add-participant popover (fields + permission above the combined model
/// list with the reasoning ladder + Fast sidecar) minus the Add button, plus
/// the Remove row — model, reasoning, fast, permission, authority, stage,
/// role and brief all live in the one familiar surface.
///
/// Commit model: discrete edits (and picker-driven model/reasoning changes,
/// coalesced per runloop tick) apply live through `onApply`; typed Role/Brief
/// drafts flush once on close.
struct RosterParticipantEditorPopover: View {
    let catalogs: [ProviderModelCatalog]
    let canRemove: Bool
    /// Live-apply: replace this entry in the roster draft + commit. Never
    /// closes the popover.
    let onApply: (RemoteSessionModel.RosterDraftEntry) -> Void
    /// Remove this participant (host closes the popover).
    let onRemove: () -> Void
    var onDismissRequest: () -> Void = {}

    @State private var entry: RemoteSessionModel.RosterDraftEntry
    @State private var lastApplied: RemoteSessionModel.RosterDraftEntry
    @State private var applyScheduled = false
    #if os(iOS)
        @Environment(\.horizontalSizeClass) private var horizontalSizeClass
        private var compactWidth: Bool { horizontalSizeClass == .compact }
    #else
        private var compactWidth: Bool { false }
    #endif

    init(
        entry: RemoteSessionModel.RosterDraftEntry,
        catalogs: [ProviderModelCatalog],
        canRemove: Bool,
        onApply: @escaping (RemoteSessionModel.RosterDraftEntry) -> Void,
        onRemove: @escaping () -> Void,
        onDismissRequest: @escaping () -> Void = {}
    ) {
        self.catalogs = catalogs
        self.canRemove = canRemove
        self.onApply = onApply
        self.onRemove = onRemove
        self.onDismissRequest = onDismissRequest
        self._entry = State(initialValue: entry)
        self._lastApplied = State(initialValue: entry)
    }

    var body: some View {
        ProviderModelPickerPanel(
            catalogs: catalogs,
            provider: $entry.provider,
            modelId: $entry.model,
            reasoningEffort: $entry.reasoningEffort,
            fastModeEnabled: $entry.fastModeEnabled,
            kimiThinkingEnabled: $entry.thinkingEnabled,
            // iPhone popover balloons get less width than our iPad panel —
            // a fixed 320 overflows and clips the leading labels there.
            listWidth: compactWidth ? 208 : 252,
            bodyHeight: 420,
            bodyMaxHeight: 420,
            alwaysShowsSidecar: true,
            showsDisabledFastPill: true,
            sidecarAccessory: AnyView(
                RosterPermissionSidecarPicker(
                    permissionPresetId: $entry.permissionPresetId,
                    accent: TWTheme.providerAccent(entry.provider, modelId: entry.model))),
            onDismissRequest: onDismissRequest
        ) {
            RosterParticipantConfigFields(
                entry: $entry,
                onDiscreteChange: applyDiscrete,
                onRemove: canRemove ? onRemove : nil)
        }
        // The panel writes provider/model/reasoning/fast/thinking straight
        // onto the entry binding — live-apply those too, coalesced to one
        // commit per runloop tick so a provider switch's normalization
        // cascade (model reset → reasoning → fast) sends one roster update.
        .onChange(of: entry.provider) { _, _ in scheduleApply() }
        .onChange(of: entry.model) { _, _ in scheduleApply() }
        .onChange(of: entry.reasoningEffort) { _, _ in scheduleApply() }
        .onChange(of: entry.fastModeEnabled) { _, _ in scheduleApply() }
        .onChange(of: entry.thinkingEnabled) { _, _ in scheduleApply() }
        .onChange(of: entry.permissionPresetId) { _, _ in scheduleApply() }
        .onDisappear {
            // Flush the typed Role/Brief drafts (and any not-yet-applied
            // discrete change) exactly once on close — the desktop popover's
            // commit-on-unmount safety net.
            applyDiscrete()
        }
    }

    private func scheduleApply() {
        guard !applyScheduled else { return }
        applyScheduled = true
        DispatchQueue.main.async {
            applyScheduled = false
            applyDiscrete()
        }
    }

    private func applyDiscrete() {
        guard entry != lastApplied else { return }
        lastApplied = entry
        onApply(entry)
    }
}

// MARK: - Add-participant popover panel

/// Electron add-participant popover parity: the fields cluster stacked above
/// the combined provider/model list with the reasoning ladder + Fast sidecar
/// and an `Add` confirm — one surface, no provider-menu → editor two-step.
struct RosterAddParticipantPopover: View {
    let catalogs: [ProviderModelCatalog]
    /// Append the configured seat to the roster (host closes the popover).
    let onAdd: (RemoteSessionModel.RosterDraftEntry) -> Void
    var onDismissRequest: () -> Void = {}

    @State private var entry: RemoteSessionModel.RosterDraftEntry
    #if os(iOS)
        @Environment(\.horizontalSizeClass) private var horizontalSizeClass
        private var compactWidth: Bool { horizontalSizeClass == .compact }
    #else
        private var compactWidth: Bool { false }
    #endif

    init(
        catalogs: [ProviderModelCatalog],
        seedProvider: String? = nil,
        onAdd: @escaping (RemoteSessionModel.RosterDraftEntry) -> Void,
        onDismissRequest: @escaping () -> Void = {}
    ) {
        self.catalogs = catalogs
        self.onAdd = onAdd
        self.onDismissRequest = onDismissRequest
        let provider = seedProvider ?? catalogs.first?.provider ?? "claude"
        self._entry = State(
            initialValue: RemoteSessionModel.RosterDraftEntry(
                id: "draft-\(UUID().uuidString.prefix(8))",
                provider: provider,
                model: nil,
                role: TWTheme.providerLabel(provider),
                brief: "",
                enabled: true,
                reasoningEffort: provider.lowercased() == "kimi" ? "on" : nil,
                thinkingEnabled: provider.lowercased() == "kimi"
            ))
    }

    var body: some View {
        ProviderModelPickerPanel(
            catalogs: catalogs,
            provider: providerBinding,
            modelId: $entry.model,
            reasoningEffort: $entry.reasoningEffort,
            fastModeEnabled: $entry.fastModeEnabled,
            kimiThinkingEnabled: $entry.thinkingEnabled,
            // iPhone popover balloons get less width than our iPad panel —
            // a fixed 320 overflows and clips the leading labels there.
            listWidth: compactWidth ? 208 : 252,
            bodyHeight: 420,
            bodyMaxHeight: 420,
            alwaysShowsSidecar: true,
            showsDisabledFastPill: true,
            sidecarAccessory: AnyView(
                RosterPermissionSidecarPicker(
                    permissionPresetId: $entry.permissionPresetId,
                    accent: TWTheme.providerAccent(entry.provider, modelId: entry.model))),
            confirmLabel: "Add",
            onConfirm: { onAdd(entry) },
            onDismissRequest: onDismissRequest
        ) {
            // Same config column as the editor popover (minus Remove) so both
            // surfaces read as one familiar place.
            RosterParticipantConfigFields(entry: $entry)
        }
    }

    /// Keep the default role tracking the provider until the user names one —
    /// the desktop add flow re-seeds role/label per provider the same way.
    private var providerBinding: Binding<String> {
        Binding(
            get: { entry.provider },
            set: { provider in
                let wasDefaultRole =
                    entry.role.isEmpty
                    || entry.role == TWTheme.providerLabel(entry.provider)
                entry.provider = provider
                if wasDefaultRole {
                    entry.role = TWTheme.providerLabel(provider)
                }
            }
        )
    }
}
