import Foundation
import Testing
import TaskWraithKit

@testable import TaskWraithUI

@Suite("iOS parity fixes")
struct IosParityFixesTests {
    @MainActor
    @Test func settingsProviderSnapshotsPreferFirstLaunchReadinessCards() throws {
        let cards = try decode(
            [FirstLaunchProviderCard].self,
            """
            [
              {
                "id":"codex",
                "label":"Codex",
                "optional":false,
                "statusKind":"ready",
                "statusText":"Ready on Mac",
                "detail":"Codex CLI is signed in.",
                "setupHint":"Manage Codex on the Mac.",
                "setupCommands":[],
                "usageWindows":[{"id":"codex-5h","label":"Current session","usedPercent":28,"resetAt":null}]
              },
              {
                "id":"gemini",
                "label":"Gemini",
                "optional":true,
                "statusKind":"ready",
                "statusText":"Historical only",
                "detail":"Retired provider.",
                "setupHint":"No new runs.",
                "setupCommands":[],
                "usageWindows":[]
              }
            ]
            """)
        let fallbackModels = try decode([ModelOption].self, #"[{"id":"fallback-model"}]"#)

        let snapshots = SettingsProviderSnapshot.build(
            providerCards: cards,
            modelUsageProviders: [],
            providerModels: ["codex": fallbackModels])

        #expect(snapshots.map(\.id) == ["codex"])
        #expect(snapshots.first?.statusKind == "ready")
        #expect(snapshots.first?.statusText == "Ready on Mac")
        #expect(snapshots.first?.usageWindows.map(\.id) == ["codex-5h"])
    }

    @MainActor
    @Test func settingsProviderSnapshotsFallBackToModelCountsOnlyWithoutReadinessCards() throws {
        let fallbackModels = try decode([ModelOption].self, #"[{"id":"claude-sonnet"}]"#)
        let usage = try decode(
            [ModelUsageMessage.ProviderUsage].self,
            """
            [
              {
                "provider":"claude",
                "windows":[{"id":"claude-day","label":"Daily","usedPercent":40,"limitLabel":"100k","resetAt":null}]
              }
            ]
            """)

        let snapshots = SettingsProviderSnapshot.build(
            providerCards: [],
            modelUsageProviders: usage,
            providerModels: ["claude": fallbackModels])

        let claude = try #require(snapshots.first { $0.id == "claude" })
        #expect(claude.statusKind == "notObservable")
        #expect(claude.statusText == "1 model available")
        #expect(claude.usageWindows.map(\.id) == ["claude-day"])
    }

    @MainActor
    @Test func proposedPlanProviderResolutionNeverFallsBackToClaude() throws {
        let card = try remoteTaskCard(
            #"{"id":"task-1","threadId":"thread-1","provider":"codex"}"#)
        let snapshot = RemoteThreadSnapshot(threadId: "thread-1", provider: "claude")

        #expect(
            RemoteSessionModel.proposedPlanProvider(
                threadId: "thread-1",
                taskCards: [card],
                threadSnapshots: ["thread-1": snapshot]) == "codex")
        #expect(
            RemoteSessionModel.proposedPlanProvider(
                threadId: "thread-2",
                taskCards: [],
                threadSnapshots: [
                    "thread-2": RemoteThreadSnapshot(threadId: "thread-2", provider: "cursor")
                ]) == "cursor")
        #expect(
            RemoteSessionModel.proposedPlanProvider(
                threadId: "missing",
                taskCards: [],
                threadSnapshots: [:]) == nil)
    }

    @MainActor
    @Test func questionAnsweringRequiresExplicitThreadCapability() throws {
        let canAnswer = try remoteTaskCard(
            #"{"id":"card-1","threadId":"thread-1","capabilities":{"answer":true}}"#)
        let cannotAnswer = try remoteTaskCard(
            #"{"id":"card-2","threadId":"thread-2","capabilities":{"answer":false}}"#)
        let unknownCapabilities = try remoteTaskCard(#"{"id":"card-3","threadId":"thread-3"}"#)

        #expect(QuestionRow.canAnswerQuestion(threadId: "thread-1", taskCards: [canAnswer]) == true)
        #expect(QuestionRow.canAnswerQuestion(threadId: "card-1", taskCards: [canAnswer]) == true)
        #expect(QuestionRow.canAnswerQuestion(threadId: "thread-2", taskCards: [cannotAnswer]) == false)
        #expect(
            QuestionRow.canAnswerQuestion(threadId: "thread-3", taskCards: [unknownCapabilities])
                == false)
        #expect(QuestionRow.canAnswerQuestion(threadId: "missing", taskCards: [canAnswer]) == false)
        #expect(QuestionRow.canAnswerQuestion(threadId: nil, taskCards: [canAnswer]) == false)
    }

    @MainActor
    @Test func approvalActionsReflectAdvertisedDecisionSet() throws {
        let actions = ApprovalActionDescriptor.visibleActions(from: [
            "useProviderNative", "useTaskWraithSubthread", "decline", "cancel", "decline", " ",
        ])

        #expect(actions.map(\.id) == [
            "useProviderNative", "useTaskWraithSubthread", "decline", "cancel",
        ])
        #expect(actions.first?.prominent == true)
        #expect(actions.filter { $0.destructive }.map(\.id) == ["decline", "cancel"])
        #expect(
            ApprovalActionDescriptor.visibleActions(from: nil).map(\.id) == ["accept", "decline"])
    }

    @MainActor
    @Test func ensembleDisplayParticipantsBackfillRosterModelsForBrandTinting() throws {
        let state = try decode(
            RemoteEnsembleState.self,
            """
            {
              "threadId":"thread-1",
              "participants":[
                {"participantId":"p-ollama","provider":"ollama","role":"Reviewer","order":1,"status":"running"}
              ],
              "roster":[
                {"id":"p-ollama","provider":"ollama","role":"Reviewer","enabled":true,"order":1,"model":"qwen3:4b"}
              ]
            }
            """)

        #expect(state.displayParticipants.first?.model == "qwen3:4b")
    }

    @MainActor
    @Test func mentionCandidatesUseSpoofBrandLabelsForOllamaParticipantsWithoutRoles() throws {
        let state = try decode(
            RemoteEnsembleState.self,
            """
            {
              "threadId":"thread-1",
              "participants":[
                {"participantId":"p-ollama","provider":"ollama","order":1,"status":"running"}
              ],
              "roster":[
                {"id":"p-ollama","provider":"ollama","enabled":true,"order":1,"model":"qwen3:4b"}
              ]
            }
            """)

        let candidate = try #require(twMentionCandidates(participants: state.displayParticipants).first)
        #expect(candidate.display == "Alibaba")
        #expect(candidate.insertText == "@Alibaba")
        #expect(candidate.model == "qwen3:4b")
    }

    @MainActor
    @Test func subThreadReturnRowsDuringLiveRunRenderAfterLiveBlock() throws {
        let row = try decode(
            RemoteThreadSnapshot.Row.self,
            """
            {
              "id":"row-1",
              "role":"tool",
              "kind":"tool",
              "preview":"Returned result",
              "timestamp":"2026-07-03T18:40:00Z",
              "subThreadReturn":{"subThreadId":"sub-1","provider":"codex","title":"Sub-thread"}
            }
            """)

        #expect(twShouldRenderAfterLiveBlock(row, liveStartedAt: "2026-07-03T18:35:00Z") == true)
        #expect(twShouldRenderAfterLiveBlock(row, liveStartedAt: "2026-07-03T18:45:00Z") == false)
    }

    @MainActor
    @Test func ordinaryToolRowsStayInTheirNormalOrderingDuringLiveRun() throws {
        let row = try decode(
            RemoteThreadSnapshot.Row.self,
            """
            {
              "id":"row-2",
              "runId":"run-1",
              "role":"tool",
              "kind":"tool",
              "preview":"Tool activity",
              "timestamp":"2026-07-03T18:40:00Z"
            }
            """)

        #expect(twShouldRenderAfterLiveBlock(row, liveStartedAt: "2026-07-03T18:35:00Z") == false)
    }

    private func remoteTaskCard(_ json: String) throws -> RemoteTaskCard {
        try decode(RemoteTaskCard.self, json)
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }
}
