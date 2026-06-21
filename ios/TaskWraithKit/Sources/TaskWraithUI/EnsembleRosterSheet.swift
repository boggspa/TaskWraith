// EnsembleRosterSheet — the dedicated, full-page ensemble roster editor.
//
// Reached from the transcript's "Roster" toolbar icon AND (slice A2) from
// tapping a participant chip in the composer's above-row. Supersedes the
// cramped per-chip sheet: one comfortable page listing every participant with
// reorder / add / remove, per-participant detail editing (reusing
// `RosterChipEditor`), and — once bridged (slices B1–B3) — load / save / delete
// of reusable roster presets.
//
// Live-roster editing reuses the EXISTING bridge end-to-end: it builds a
// `[RosterDraftEntry]` from `model.ensembleStates[threadId].roster`, edits it,
// and commits via `model.updateEnsembleRoster(...)`. The `pendingOrderIds`
// reconcile mirrors `EditableRosterStrip` so an in-flight snapshot can't snap a
// just-committed reorder back.

import SwiftUI
import TaskWraithKit

public struct EnsembleRosterSheet: View {
    @ObservedObject var model: RemoteSessionModel
    let threadId: String
    let workspaceId: String

    @Environment(\.dismiss) private var dismiss
    @State private var draft: [RemoteSessionModel.RosterDraftEntry] = []
    @State private var editingEntry: RemoteSessionModel.RosterDraftEntry? = nil
    /// Id-order we last committed; suppress reconcile until the Mac echoes a
    /// matching order so an in-flight snapshot can't snap a reorder back.
    @State private var pendingOrderIds: [String]? = nil
    /// Consume `model.rosterFocusParticipantId` exactly once (chip-tap deep link).
    @State private var didConsumeFocus = false
    /// Preset pending a "replace the roster?" confirmation.
    @State private var presetToApply: RemoteEnsemblePreset? = nil

    public init(model: RemoteSessionModel, threadId: String, workspaceId: String) {
        self.model = model
        self.threadId = threadId
        self.workspaceId = workspaceId
    }

    private var state: RemoteEnsembleState? { model.ensembleStates[threadId] }

    private var catalogs: [ProviderModelCatalog] {
        model.providerModels
            .map { ProviderModelCatalog(provider: $0.key, models: $0.value) }
            .filter { !TWTheme.isRetiredProvider($0.provider) }
            .sorted { TWTheme.providerLabel($0.provider) < TWTheme.providerLabel($1.provider) }
    }

    private var remoteRoster: [RemoteSessionModel.RosterDraftEntry] {
        (state?.roster ?? [])
            .sorted { ($0.order ?? 0) < ($1.order ?? 0) }
            .map { entry in
                RemoteSessionModel.RosterDraftEntry(
                    id: entry.id,
                    provider: entry.provider,
                    model: entry.model,
                    role: entry.role ?? TWTheme.providerLabel(entry.provider),
                    brief: entry.brief ?? "",
                    enabled: entry.enabled ?? true,
                    permissionPresetId: entry.permissionPresetId,
                    reasoningEffort: entry.reasoningEffort,
                    fastModeEnabled: entry.fastModeEnabled ?? false,
                    thinkingEnabled: entry.thinkingEnabled ?? false
                )
            }
    }

    private func roundStatus(for id: String) -> String? {
        state?.participants?.first { $0.participantId == id }?.status
    }

    public var body: some View {
        NavigationStack {
            List {
                presetsSection
                participantsSection
                addSection
            }
            .navigationTitle("Roster")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                #if os(iOS)
                    ToolbarItem(placement: .topBarLeading) {
                        EditButton()
                    }
                #endif
            }
            .sheet(item: $editingEntry) { entry in
                RosterChipEditor(
                    entry: entry,
                    catalogs: catalogs,
                    canRemove: draft.count > 1,
                    onApply: { updated in
                        if let index = draft.firstIndex(where: { $0.id == updated.id }) {
                            draft[index] = updated
                        }
                        editingEntry = nil
                        commit()
                    },
                    onMove: { direction in
                        guard let index = draft.firstIndex(where: { $0.id == entry.id }) else {
                            return
                        }
                        let target = index + direction
                        guard target >= 0, target < draft.count else { return }
                        draft.swapAt(index, target)
                        commit()
                    },
                    onRemove: {
                        draft.removeAll { $0.id == entry.id }
                        editingEntry = nil
                        commit()
                    }
                )
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
            }
            .confirmationDialog(
                "Replace the current roster?",
                isPresented: Binding(
                    get: { presetToApply != nil },
                    set: { if !$0 { presetToApply = nil } }
                ),
                presenting: presetToApply
            ) { preset in
                Button("Replace with \(preset.name ?? "preset")", role: .destructive) {
                    applyPreset(preset)
                    presetToApply = nil
                }
                Button("Cancel", role: .cancel) { presetToApply = nil }
            } message: { preset in
                Text("This swaps in \(preset.participants?.count ?? 0) participant\((preset.participants?.count ?? 0) == 1 ? "" : "s") from “\(preset.name ?? "preset")”. Your current roster isn’t saved unless you save it as a preset first.")
            }
        }
        .twColorScheme()
        .onAppear {
            if draft.isEmpty { draft = remoteRoster }
            consumeFocusIfNeeded()
        }
        .onChange(of: remoteRoster) { _, fresh in
            // Reconcile from the Mac unless mid-edit (detail open).
            guard editingEntry == nil else { return }
            if let pending = pendingOrderIds {
                let freshIds = fresh.map(\.id)
                if freshIds == pending || Set(freshIds) != Set(pending) {
                    pendingOrderIds = nil
                    draft = fresh
                }
                return
            }
            draft = fresh
        }
    }

    @ViewBuilder
    private var participantsSection: some View {
        Section {
            if draft.isEmpty {
                Text("No participants yet.")
                    .font(.footnote)
                    .foregroundStyle(TWTheme.textMuted)
            } else {
                ForEach(draft) { entry in
                    Button {
                        editingEntry = entry
                    } label: {
                        participantRow(entry)
                    }
                    .buttonStyle(.plain)
                }
                .onMove { indices, newOffset in
                    draft.move(fromOffsets: indices, toOffset: newOffset)
                    commit()
                }
                .onDelete { indices in
                    // Keep at least one participant (the Mac also rejects an
                    // empty / all-disabled roster).
                    guard draft.count - indices.count >= 1 else { return }
                    draft.remove(atOffsets: indices)
                    commit()
                }
            }
        } header: {
            Text("Participants")
        } footer: {
            Text("Drag to reorder turn order. Tap a participant to edit its model, reasoning, permissions, role and brief.")
        }
    }

    private func participantRow(_ entry: RemoteSessionModel.RosterDraftEntry) -> some View {
        let retired = TWTheme.isRetiredProvider(entry.provider)
        let accent = retired ? TWTheme.textMuted : TWTheme.providerAccent(entry.provider)
        let status = roundStatus(for: entry.id)
        let title = entry.role.isEmpty ? TWTheme.providerLabel(entry.provider) : entry.role
        let subtitle = "\(TWTheme.providerLabel(entry.provider)) · \(entry.model ?? "CLI Default")"
        return HStack(spacing: 10) {
            Circle()
                .fill(accent.opacity(entry.enabled ? 1 : 0.35))
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(entry.enabled ? TWTheme.textPrimary : TWTheme.textMuted)
                    .strikethrough(retired, color: TWTheme.textMuted)
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if !entry.enabled {
                Text("off")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TWTheme.textMuted)
                    .textCase(.uppercase)
            }
            if status == "done" {
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(TWTheme.statusSuccess)
            } else if status == "running" || state?.activeParticipantId == entry.id {
                Image(systemName: "waveform")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(accent)
            }
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(TWTheme.textMuted)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    private var addSection: some View {
        Section {
            Menu {
                ForEach(catalogs.map(\.provider), id: \.self) { provider in
                    Button {
                        addParticipant(provider)
                    } label: {
                        Label(TWTheme.providerLabel(provider), systemImage: "cpu")
                    }
                }
            } label: {
                Label("Add participant", systemImage: "plus")
            }
        }
    }

    private func addParticipant(_ provider: String) {
        draft.append(
            RemoteSessionModel.RosterDraftEntry(
                id: "draft-\(UUID().uuidString.prefix(8))",
                provider: provider,
                model: nil,
                role: TWTheme.providerLabel(provider),
                brief: "",
                enabled: true
            ))
        commit()
    }

    @ViewBuilder
    private var presetsSection: some View {
        Section {
            if model.ensemblePresets.isEmpty {
                Text("No saved presets yet. Create one on the Mac (or save this roster, coming soon).")
                    .font(.footnote)
                    .foregroundStyle(TWTheme.textMuted)
            } else {
                Menu {
                    ForEach(model.ensemblePresets) { preset in
                        Button {
                            presetToApply = preset
                        } label: {
                            Text("\(preset.name ?? "Untitled")  ·  \(preset.participants?.count ?? 0)")
                        }
                    }
                } label: {
                    Label("Load preset", systemImage: "square.and.arrow.down")
                }
            }
        } header: {
            Text("Presets")
        }
    }

    /// Replace the working roster with a preset's participants. Fresh `draft-`
    /// ids make the Mac materialize brand-new participants (the existing
    /// roster-update path), so loading a preset == applying it.
    private func applyPreset(_ preset: RemoteEnsemblePreset) {
        let entries = (preset.participants ?? [])
            .sorted { ($0.order ?? 0) < ($1.order ?? 0) }
            .map { participant in
                RemoteSessionModel.RosterDraftEntry(
                    id: "draft-\(UUID().uuidString.prefix(8))",
                    provider: participant.provider,
                    model: participant.model,
                    role: participant.role ?? TWTheme.providerLabel(participant.provider),
                    brief: participant.brief ?? "",
                    enabled: participant.enabled ?? true,
                    permissionPresetId: participant.permissionPresetId,
                    reasoningEffort: participant.reasoningEffort,
                    fastModeEnabled: participant.fastModeEnabled ?? false,
                    thinkingEnabled: participant.thinkingEnabled ?? false
                )
            }
        guard !entries.isEmpty else { return }
        draft = entries
        commit()
    }

    private func commit() {
        guard !draft.isEmpty else { return }
        pendingOrderIds = draft.map(\.id)
        model.updateEnsembleRoster(
            workspaceId: workspaceId, threadId: threadId, entries: draft)
    }

    private func consumeFocusIfNeeded() {
        guard !didConsumeFocus, let focusId = model.rosterFocusParticipantId else { return }
        didConsumeFocus = true
        model.rosterFocusParticipantId = nil
        if let entry = draft.first(where: { $0.id == focusId }) {
            editingEntry = entry
        }
    }
}
