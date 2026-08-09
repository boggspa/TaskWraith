import Foundation
import Testing

@testable import TaskWraithKit
@testable import TaskWraithUI

@Suite("Host mission control projection")
struct HostMissionControlViewTests {
  @Test("active work leads the timeline and every participant remains visible")
  func orderingAndParticipantBound() throws {
    let projection = HostMissionControlProjection(snapshot: fixture())

    #expect(
      projection.missions.map(\.missionId) == ["mission-active", "mission-new", "mission-old"])
    #expect(projection.rounds.map(\.roundId) == ["round-running", "round-complete"])
    #expect(projection.activeMissionCount == 1)
    #expect(projection.participantCount == 30)
    #expect(projection.participantGroups.map(\.title) == ["Alpha thread", "Zeta thread"])
    #expect(projection.participantGroups.allSatisfy { $0.participants.count == 15 })
    #expect(projection.participantGroups[0].participants.map(\.order) == Array(0..<15))
  }

  @Test("missing snapshots render an honest empty projection")
  func unavailableProjection() {
    let projection = HostMissionControlProjection(snapshot: nil)

    #expect(projection.missions.isEmpty)
    #expect(projection.rounds.isEmpty)
    #expect(projection.participantGroups.isEmpty)
    #expect(projection.activeMissionCount == 0)
    #expect(projection.participantCount == 0)
    #expect(HostMissionControlCopy.phase(.reconnecting) == "Offline cache")
  }

  @Test("seat toggles use the exact Host command target and argument shape")
  func seatToggleCommand() {
    let participant = HostParticipantProjection(
      id: "participant-1",
      threadId: "thread-1",
      providerId: "codex",
      role: "Reviewer",
      order: 0,
      enabled: true,
      active: false)

    let command = HostMissionControlCommands.seatToggle(participant: participant)

    #expect(command.target == ["threadId": "thread-1"])
    #expect(
      command.arguments == [
        "participantId": .string("participant-1"),
        "enabled": .bool(false),
      ])
  }

  private func fixture() -> HostSnapshot {
    var snapshot = createEmptyHostSnapshot(
      generation: 4,
      cursor: 12,
      freshness: .live,
      generatedAt: "2026-08-09T20:00:00Z")
    snapshot.threads = [
      HostThreadProjection(
        id: "thread-z",
        workspaceId: nil,
        title: "Zeta thread",
        chatKind: .ensemble,
        archived: false,
        pinned: false,
        updatedAt: 100,
        messageCount: 1),
      HostThreadProjection(
        id: "thread-a",
        workspaceId: nil,
        title: "Alpha thread",
        chatKind: .ensemble,
        archived: false,
        pinned: false,
        updatedAt: 200,
        messageCount: 1),
    ]
    snapshot.missions = [
      HostMissionProjection(
        missionId: "mission-old",
        title: "Old mission",
        status: .completed,
        updatedAt: 100),
      HostMissionProjection(
        missionId: "mission-active",
        title: "Active mission",
        status: .active,
        updatedAt: 50),
      HostMissionProjection(
        missionId: "mission-new",
        title: "New mission",
        status: .failed,
        updatedAt: 300),
    ]
    snapshot.rounds = [
      HostRoundProjection(
        roundId: "round-complete",
        threadId: "thread-z",
        status: .completed,
        endedAt: 500,
        participantIds: [],
        providerRunIds: []),
      HostRoundProjection(
        roundId: "round-running",
        threadId: "thread-a",
        status: .running,
        startedAt: 100,
        participantIds: [],
        providerRunIds: []),
    ]
    snapshot.participants = (0..<30).map { index in
      let firstGroup = index < 15
      let order = firstGroup ? index : index - 15
      return HostParticipantProjection(
        id: "participant-\(index)",
        threadId: firstGroup ? "thread-z" : "thread-a",
        providerId: index.isMultiple(of: 2) ? "codex" : "claude",
        role: "Seat \(index)",
        stage: index.isMultiple(of: 3) ? .reviewer : .worker,
        order: order,
        enabled: true,
        status: index == 0 ? "running" : "idle",
        active: index == 0)
    }
    return snapshot
  }
}
