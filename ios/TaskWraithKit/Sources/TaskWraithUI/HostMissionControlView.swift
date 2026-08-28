import SwiftUI
import TaskWraithKit

struct HostMissionControlProjection: Equatable {
  struct ParticipantGroup: Identifiable, Equatable {
    let threadId: String
    let title: String
    let participants: [HostParticipantProjection]

    var id: String { threadId }
  }

  let missions: [HostMissionProjection]
  let rounds: [HostRoundProjection]
  let participantGroups: [ParticipantGroup]
  /// Settled questions that hold an audit receipt, newest settle first,
  /// capped at ten (desktop projectHostMissionControl parity). Open
  /// questions and receipt-less settles are excluded — this section is the
  /// audit trail, not the inbox.
  let questionReceipts: [HostQuestionProjection]
  private let runsById: [String: HostRunProjection]

  init(snapshot: HostSnapshot?) {
    guard let snapshot else {
      missions = []
      rounds = []
      participantGroups = []
      questionReceipts = []
      runsById = [:]
      return
    }

    missions = snapshot.missions.sorted {
      let left = Self.missionPriority($0.status)
      let right = Self.missionPriority($1.status)
      if left != right { return left < right }
      if $0.updatedAt != $1.updatedAt { return $0.updatedAt > $1.updatedAt }
      return $0.missionId < $1.missionId
    }
    rounds = snapshot.rounds.sorted {
      let left = Self.roundPriority($0.status)
      let right = Self.roundPriority($1.status)
      if left != right { return left < right }
      let leftAt = $0.endedAt ?? $0.startedAt ?? 0
      let rightAt = $1.endedAt ?? $1.startedAt ?? 0
      if leftAt != rightAt { return leftAt > rightAt }
      return $0.roundId < $1.roundId
    }

    let titles = Dictionary(uniqueKeysWithValues: snapshot.threads.map { ($0.id, $0.title) })
    participantGroups = Dictionary(grouping: snapshot.participants, by: \.threadId)
      .map { threadId, participants in
        ParticipantGroup(
          threadId: threadId,
          title: titles[threadId] ?? "Thread",
          participants: participants.sorted {
            if $0.order != $1.order { return $0.order < $1.order }
            return $0.id < $1.id
          })
      }
      .sorted {
        let titleOrder = $0.title.localizedStandardCompare($1.title)
        if titleOrder != .orderedSame { return titleOrder == .orderedAscending }
        return $0.threadId < $1.threadId
      }

    // uniquingKeysWith rather than uniqueKeysWithValues: a snapshot with a
    // duplicated runId is malformed, but malformed must degrade, not trap.
    runsById = Dictionary(
      snapshot.runs.map { ($0.runId, $0) }, uniquingKeysWith: { _, last in last })
    questionReceipts = Array(
      snapshot.questions
        .filter { $0.status != .open && $0.receiptId != nil }
        .sorted {
          let leftAt = $0.answeredAt ?? $0.askedAt
          let rightAt = $1.answeredAt ?? $1.askedAt
          if leftAt != rightAt { return leftAt > rightAt }
          return $0.questionId < $1.questionId
        }
        .prefix(10))
  }

  var activeMissionCount: Int { missions.filter { $0.status == .active }.count }
  var participantCount: Int { participantGroups.reduce(0) { $0 + $1.participants.count } }

  /// Per-provider terminal outcomes for one round's runs, in the round's own
  /// run order ("claude: completed · grok: failed") — desktop
  /// roundProviderOutcomes parity. Run ids the snapshot no longer carries are
  /// skipped, never rendered as holes.
  func runOutcomes(for round: HostRoundProjection) -> String {
    round.providerRunIds
      .compactMap { runsById[$0] }
      .map { "\($0.providerId): \($0.providerOutcome.rawValue)" }
      .joined(separator: " · ")
  }

  private static func missionPriority(_ status: HostMissionOutcome) -> Int {
    status == .active ? 0 : 1
  }

  private static func roundPriority(_ status: HostRoundOutcome) -> Int {
    status == .running ? 0 : 1
  }
}

enum HostMissionControlCopy {
  static func phase(_ phase: PairedHostProjectionPhase) -> String {
    switch phase {
    case .live: return "Live"
    case .connecting: return "Connecting"
    case .reconnecting: return "Offline cache"
    case .unavailable: return "Unavailable"
    }
  }

  static func mission(_ status: HostMissionOutcome) -> String {
    switch status {
    case .active: return "Active"
    case .completed: return "Completed"
    case .blocked: return "Blocked"
    case .cancelled: return "Cancelled"
    case .failed: return "Failed"
    case .unknown: return "Unknown"
    }
  }

  static func round(_ status: HostRoundOutcome) -> String {
    switch status {
    case .running: return "Running"
    case .completed: return "Completed"
    case .cancelled: return "Cancelled"
    case .failed: return "Failed"
    case .unknown: return "Unknown"
    }
  }
}

enum HostMissionControlCommands {
  static func seatToggle(
    participant: HostParticipantProjection
  ) -> (target: [String: String], arguments: [String: HostJSONAny]) {
    (
      target: ["threadId": participant.threadId],
      arguments: [
        "participantId": .string(participant.id),
        "enabled": .bool(!participant.enabled),
      ]
    )
  }
}

struct HostMissionControlLauncher: View {
  @ObservedObject var controller: PairedHostSessionController
  @State private var presented = false

  private var projection: HostMissionControlProjection {
    HostMissionControlProjection(snapshot: controller.snapshot)
  }

  private var summary: String {
    if controller.snapshot == nil {
      return HostMissionControlCopy.phase(controller.phase)
    }
    let active = projection.activeMissionCount
    let participants = projection.participantCount
    return "\(active) active · \(participants) participant\(participants == 1 ? "" : "s")"
  }

  var body: some View {
    Button {
      presented = true
    } label: {
      HStack(spacing: 10) {
        Image(systemName: "scope")
          .foregroundStyle(TWTheme.chroma1)
        VStack(alignment: .leading, spacing: 2) {
          Text("Mission Control")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(TWTheme.textPrimary)
          Text(summary)
            .font(.caption)
            .foregroundStyle(TWTheme.textSecondary)
        }
        Spacer(minLength: 8)
        Image(systemName: "chevron.right")
          .font(.caption.weight(.semibold))
          .foregroundStyle(TWTheme.textMuted)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Mission Control")
    .accessibilityValue(summary)
    .accessibilityHint("Shows Host missions, rounds, and ensemble participants")
    .sheet(isPresented: $presented) {
      HostMissionControlView(controller: controller)
        .twSheetLiquidGlass(detents: [.medium, .large])
    }
  }
}

struct HostMissionControlView: View {
  @ObservedObject var controller: PairedHostSessionController
  @Environment(\.dismiss) private var dismiss
  @State private var seatMutations: Set<String> = []
  @State private var actionMessage: String?

  private var projection: HostMissionControlProjection {
    HostMissionControlProjection(snapshot: controller.snapshot)
  }

  private var canToggleSeats: Bool {
    guard controller.isLive, let capabilities = controller.welcome?.capabilities else {
      return false
    }
    return capabilities.contains(.commands)
      && capabilities.contains(.receipts)
      && capabilities.contains(.ensemble)
  }

  var body: some View {
    NavigationStack {
      List {
        Group {
          statusSection
          missionSection
          roundSection
          receiptsSection
          participantSections
        }
        .twGlassSheetRowBackground()
      }
      .twGlassSheetListCanvas()
      .background(Color.clear)
      .navigationTitle("Mission Control")
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
  }

  @ViewBuilder
  private var statusSection: some View {
    Section {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Circle()
          .fill(controller.isLive ? TWTheme.statusSuccess : TWTheme.statusAttention)
          .frame(width: 8, height: 8)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 3) {
          Text(HostMissionControlCopy.phase(controller.phase))
            .font(.subheadline.weight(.semibold))
          if let generation = controller.generation, let cursor = controller.cursor {
            Text("Generation \(generation) · Cursor \(cursor)")
              .font(.caption.monospacedDigit())
              .foregroundStyle(TWTheme.textSecondary)
          } else {
            Text("Waiting for an authoritative Host snapshot")
              .font(.caption)
              .foregroundStyle(TWTheme.textSecondary)
          }
        }
        Spacer()
        Button {
          Task { await controller.refreshNow() }
        } label: {
          if controller.resyncInFlight {
            ProgressView().controlSize(.small)
          } else {
            Label("Refresh", systemImage: "arrow.clockwise")
              .labelStyle(.iconOnly)
          }
        }
        .disabled(controller.resyncInFlight || controller.phase == .unavailable)
        .accessibilityLabel(controller.resyncInFlight ? "Refreshing" : "Refresh missions")
      }
      .accessibilityElement(children: .combine)

      if let actionMessage {
        Text(actionMessage)
          .font(.footnote)
          .foregroundStyle(TWTheme.textSecondary)
          .accessibilityLabel("Last Host action: \(actionMessage)")
      }
      if let error = controller.lastError, !error.isEmpty {
        Label(error, systemImage: "exclamationmark.triangle")
          .font(.footnote)
          .foregroundStyle(TWTheme.statusAttention)
      }
    }
  }

  @ViewBuilder
  private var missionSection: some View {
    Section("Mission timeline") {
      if projection.missions.isEmpty {
        Text("No Host missions yet.")
          .foregroundStyle(TWTheme.textSecondary)
      } else {
        ForEach(projection.missions, id: \.missionId) { mission in
          HStack(alignment: .top, spacing: 10) {
            Image(systemName: missionSymbol(mission.status))
              .foregroundStyle(missionColor(mission.status))
              .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
              Text(mission.title)
                .font(.body.weight(.semibold))
                .foregroundStyle(TWTheme.textPrimary)
              HStack(spacing: 8) {
                Text(HostMissionControlCopy.mission(mission.status))
                Text(
                  Date(timeIntervalSince1970: Double(mission.updatedAt) / 1_000), style: .relative)
              }
              .font(.caption)
              .foregroundStyle(TWTheme.textSecondary)
            }
          }
          .accessibilityElement(children: .combine)
          .accessibilityLabel(mission.title)
          .accessibilityValue(
            "\(HostMissionControlCopy.mission(mission.status)), updated "
              + Date(timeIntervalSince1970: Double(mission.updatedAt) / 1_000)
              .formatted(.relative(presentation: .named)))
        }
      }
    }
  }

  @ViewBuilder
  private var roundSection: some View {
    if !projection.rounds.isEmpty {
      Section("Round timeline") {
        ForEach(projection.rounds, id: \.roundId) { round in
          VStack(alignment: .leading, spacing: 4) {
            HStack {
              Label(
                HostMissionControlCopy.round(round.status),
                systemImage: round.status == .running ? "waveform.path.ecg" : "circle.fill")
              Spacer()
              Text("\(round.participantIds.count) seats")
                .foregroundStyle(TWTheme.textSecondary)
            }
            .font(.subheadline.weight(.semibold))
            if let routing = round.routing {
              Text("\(routing.mode) · \(routing.fanout)")
                .font(.caption)
                .foregroundStyle(TWTheme.textSecondary)
            }
            // The runs family, joined per round (desktop parity): which
            // provider ended how. Decoded since the protocol port; never
            // rendered until now.
            let outcomes = projection.runOutcomes(for: round)
            if !outcomes.isEmpty {
              Text(outcomes)
                .font(.caption)
                .foregroundStyle(TWTheme.textSecondary)
                .lineLimit(2)
            }
          }
          .accessibilityElement(children: .combine)
          .accessibilityLabel("Round \(HostMissionControlCopy.round(round.status))")
          .accessibilityValue("\(round.participantIds.count) participants")
        }
      }
    }
  }

  @ViewBuilder
  private var receiptsSection: some View {
    if !projection.questionReceipts.isEmpty {
      Section("Recent question receipts") {
        ForEach(projection.questionReceipts, id: \.questionId) { question in
          VStack(alignment: .leading, spacing: 3) {
            Text(question.promptPreview)
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(TWTheme.textPrimary)
              .lineLimit(2)
            HStack(spacing: 8) {
              Text(question.status.rawValue.capitalized)
                .foregroundStyle(
                  question.status == .answered
                    ? TWTheme.statusSuccess : TWTheme.textSecondary)
              if let receiptId = question.receiptId {
                Text("Receipt \(receiptId)")
                  .font(.caption.monospaced())
                  .foregroundStyle(TWTheme.textMuted)
                  .lineLimit(1)
              }
            }
            .font(.caption)
          }
          .accessibilityElement(children: .combine)
          .accessibilityLabel(question.promptPreview)
          .accessibilityValue(
            "\(question.status.rawValue), receipt \(question.receiptId ?? "unknown")")
        }
      }
    }
  }

  @ViewBuilder
  private var participantSections: some View {
    ForEach(projection.participantGroups) { group in
      Section {
        ForEach(group.participants, id: \.id) { participant in
          participantRow(participant)
        }
      } header: {
        Text("\(group.title) · \(group.participants.count)")
      }
    }
  }

  private func participantRow(_ participant: HostParticipantProjection) -> some View {
    HStack(spacing: 10) {
      Circle()
        .fill(participant.active ? TWTheme.statusRunning : TWTheme.textMuted)
        .frame(width: 8, height: 8)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 3) {
        Text(participant.role)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(TWTheme.textPrimary)
        Text(participantDetail(participant))
          .font(.caption)
          .foregroundStyle(TWTheme.textSecondary)
      }
      Spacer(minLength: 8)
      Button(participant.enabled ? "Disable" : "Enable") {
        toggleSeat(participant)
      }
      .buttonStyle(.bordered)
      .controlSize(.small)
      .disabled(!canToggleSeats || seatMutations.contains(participant.id))
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(participant.role), \(participant.providerId)")
    .accessibilityValue(
      "\(participant.active ? "active" : participant.status ?? "idle"), "
        + (participant.enabled ? "enabled" : "disabled"))
  }

  private func participantDetail(_ participant: HostParticipantProjection) -> String {
    var parts = [participant.providerId]
    if let model = participant.modelId, !model.isEmpty { parts.append(model) }
    if let stage = participant.stage { parts.append(stage.rawValue) }
    if let status = participant.status, !status.isEmpty { parts.append(status) }
    return parts.joined(separator: " · ")
  }

  private func toggleSeat(_ participant: HostParticipantProjection) {
    guard !seatMutations.contains(participant.id) else { return }
    seatMutations.insert(participant.id)
    actionMessage = nil
    Task { @MainActor in
      defer { seatMutations.remove(participant.id) }
      do {
        let command = HostMissionControlCommands.seatToggle(participant: participant)
        let receipt = try await controller.submitCommand(
          name: .ensembleSeatToggle,
          target: command.target,
          arguments: command.arguments)
        actionMessage = "Host \(receipt.status.rawValue) seat update"
      } catch {
        actionMessage = error.localizedDescription
      }
    }
  }

  private func missionSymbol(_ status: HostMissionOutcome) -> String {
    switch status {
    case .active: return "scope"
    case .completed: return "checkmark.circle.fill"
    case .blocked: return "pause.circle.fill"
    case .cancelled: return "xmark.circle"
    case .failed: return "exclamationmark.circle.fill"
    case .unknown: return "questionmark.circle"
    }
  }

  private func missionColor(_ status: HostMissionOutcome) -> Color {
    switch status {
    case .active: return TWTheme.statusRunning
    case .completed: return TWTheme.statusSuccess
    case .blocked: return TWTheme.statusAttention
    case .failed: return TWTheme.statusFailed
    case .cancelled, .unknown: return TWTheme.textMuted
    }
  }
}
