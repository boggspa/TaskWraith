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

  @Test("settled questions with receipts project newest-first, capped at ten")
  func questionReceipts() {
    var snapshot = createEmptyHostSnapshot(
      generation: 1, cursor: 1, freshness: .live, generatedAt: "2026-08-11T20:00:00Z")
    var questions: [HostQuestionProjection] = [
      // Open — excluded regardless of receipt.
      HostQuestionProjection(
        questionId: "q-open", threadId: "t", status: .open,
        promptPreview: "Still open", askedAt: 950, receiptId: "r-open"),
      // Settled without a receipt — excluded (nothing to audit).
      HostQuestionProjection(
        questionId: "q-noreceipt", threadId: "t", status: .answered,
        promptPreview: "No receipt", askedAt: 940, answeredAt: 960),
      // Dismissed WITH a receipt — included: a receipt is a receipt.
      HostQuestionProjection(
        questionId: "q-dismissed", threadId: "t", status: .dismissed,
        promptPreview: "Dismissed", askedAt: 900, receiptId: "r-d"),
    ]
    for index in 0..<11 {
      questions.append(
        HostQuestionProjection(
          questionId: "q-\(index)", threadId: "t", status: .answered,
          promptPreview: "Q\(index)", askedAt: 100,
          answeredAt: 200 + index, receiptId: "r-\(index)"))
    }
    snapshot.questions = questions
    let projection = HostMissionControlProjection(snapshot: snapshot)

    #expect(projection.questionReceipts.count == 10)
    // Newest settle leads (dismissed one has the highest askedAt fallback).
    #expect(projection.questionReceipts.first?.questionId == "q-dismissed")
    #expect(!projection.questionReceipts.contains { $0.status == .open })
    #expect(!projection.questionReceipts.contains { $0.receiptId == nil })
    // The overflow victim is the OLDEST settle.
    #expect(!projection.questionReceipts.contains { $0.questionId == "q-0" })
  }

  @Test("round rows carry per-provider run outcomes, skipping unknown run ids")
  func roundRunOutcomes() {
    var snapshot = createEmptyHostSnapshot(
      generation: 1, cursor: 1, freshness: .live, generatedAt: "2026-08-11T20:00:00Z")
    let round = HostRoundProjection(
      roundId: "round-x", threadId: "t", status: .running,
      startedAt: 100, participantIds: [],
      providerRunIds: ["run-1", "run-2", "run-ghost"])
    snapshot.rounds = [round]
    snapshot.runs = [
      HostRunProjection(
        runId: "run-1", threadId: "t", providerId: "claude", providerOutcome: .completed),
      HostRunProjection(
        runId: "run-2", threadId: "t", providerId: "grok", providerOutcome: .failed),
    ]
    let projection = HostMissionControlProjection(snapshot: snapshot)

    #expect(projection.runOutcomes(for: round) == "claude: completed · grok: failed")
    let bare = HostRoundProjection(
      roundId: "round-empty", threadId: "t", status: .completed,
      participantIds: [], providerRunIds: [])
    #expect(projection.runOutcomes(for: bare) == "")
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
