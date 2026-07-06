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
    @Test func taskCardProjectionPublishesEmbeddedComposerMetadataUnderBothIds() throws {
        let model = makeRemoteSessionModel()
        let snapshot = try decode(
            RemoteProjectionSnapshot.self,
            """
            {
              "projections":[
                {
                  "schemaVersion":1,
                  "source":"mac",
                  "kind":"taskCard",
                  "envelopeId":"task-card:task-1",
                  "workspaceId":"ws-1",
                  "threadId":"thread-1",
                  "payload":{
                    "id":"task-1",
                    "threadId":"thread-1",
                    "title":"Ensemble run",
                    "status":"idle",
                    "provider":"claude",
                    "workspaceId":"ws-1",
                    "chatKind":"ensemble",
                    "ensembleState":{
                      "taskId":"task-1",
                      "threadId":"thread-1",
                      "status":"idle",
                      "participants":[
                        {"participantId":"p-codex","provider":"codex","role":"Builder","order":1,"status":"idle"}
                      ],
                      "roster":[
                        {"id":"p-codex","provider":"codex","role":"Builder","enabled":true,"order":1,"model":"gpt-5.5"}
                      ],
                      "queuedPrompts":[{"index":0,"text":"Run the focused tests"}]
                    },
                    "diffSummary":{
                      "taskId":"task-1",
                      "threadId":"thread-1",
                      "runId":"run-1",
                      "filesChanged":2,
                      "additions":14,
                      "deletions":3
                    }
                  }
                }
              ]
            }
            """)

        model.applySnapshot(snapshot)

        #expect(model.remoteScopeForThread("task-1") == "ws-1")
        #expect(model.remoteScopeForThread("thread-1") == "ws-1")
        #expect(model.ensembleStates["task-1"]?.displayParticipants.first?.model == "gpt-5.5")
        #expect(model.ensembleStates["thread-1"]?.queuedPrompts?.first?.text == "Run the focused tests")
        #expect(model.diffSummaries["task-1"]?.filesChanged == 2)
        #expect(model.diffSummaries["thread-1"]?.additions == 14)
    }

    @MainActor
    @Test func threadSnapshotProjectionAliasesTaskAndThreadIds() throws {
        let model = makeRemoteSessionModel()
        let snapshot = try decode(
            RemoteProjectionSnapshot.self,
            """
            {
              "projections":[
                {
                  "schemaVersion":1,
                  "source":"mac",
                  "kind":"threadSnapshot",
                  "envelopeId":"thread:thread-1",
                  "workspaceId":"ws-1",
                  "threadId":"thread-1",
                  "payload":{
                    "taskId":"task-1",
                    "threadId":"thread-1",
                    "workspaceId":"ws-1",
                    "provider":"codex",
                    "totalRows":1,
                    "rows":[
                      {"id":"row-1","role":"user","kind":"message","preview":"Fix the blank transcript"}
                    ]
                  }
                }
              ]
            }
            """)

        model.applySnapshot(snapshot)

        #expect(model.threadSnapshots["task-1"]?.rows?.first?.id == "row-1")
        #expect(model.threadSnapshots["thread-1"]?.rows?.first?.preview == "Fix the blank transcript")
        #expect(model.remoteScopeForThread("thread-1") == "ws-1")
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
    @Test func mentionHueClassUsesSpoofBrandColoursForOllamaParticipants() throws {
        let state = try decode(
            RemoteEnsembleState.self,
            """
            {
              "threadId":"thread-1",
              "participants":[
                {"participantId":"p-qwen","provider":"ollama","role":"Qwen35","order":1,"status":"running"},
                {"participantId":"p-laguna","provider":"ollama","role":"Laguna","order":2,"status":"running"}
              ],
              "roster":[
                {"id":"p-qwen","provider":"ollama","role":"Qwen35","enabled":true,"order":1,"model":"qwen3.5:9b"},
                {"id":"p-laguna","provider":"ollama","role":"Laguna","enabled":true,"order":2,"model":"laguna-xs-2.1:q8_0"}
              ]
            }
            """)

        let participants = state.displayParticipants
        #expect(twMentionHueClass(for: participants[0]) == "alibaba")
        #expect(twMentionHueClass(for: participants[1]) == "poolside")
    }

    @MainActor
    @Test func workingParticipantLabelUsesProviderRoleAndHumanModelVariant() {
        #expect(
            twWorkingParticipantLabel(provider: "ollama", role: "Qwen35", model: "qwen3.5:9b")
                == "Alibaba · Qwen35 · Qwen 3.5 (9B Param)")
        #expect(
            twWorkingParticipantLabel(provider: "ollama", model: "laguna-xs-2.1:q8_0")
                == "Poolside · Laguna XS 2.1 (33B-A3B Q8)")
        #expect(
            twWorkingParticipantLabel(provider: "codex", role: "Builder", model: "gpt-5.5")
                == "Codex · Builder · GPT-5.5")
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

    @MainActor
    private func makeRemoteSessionModel() -> RemoteSessionModel {
        let defaults = UserDefaults(suiteName: "TaskWraithUITests.\(UUID().uuidString)")!
        return RemoteSessionModel(
            identityStore: StaticIdentitySeedStore(),
            pairingStore: UserDefaultsPairedHostStore(defaults: defaults))
    }

    private struct StaticIdentitySeedStore: IdentitySeedStore {
        func loadOrCreateSeed() throws -> Data {
            Data(repeating: 7, count: 32)
        }
    }
}
