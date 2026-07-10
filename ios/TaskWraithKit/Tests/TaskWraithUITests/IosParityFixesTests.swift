import Foundation
import Combine
import Testing
import TaskWraithKit

@testable import TaskWraithUI

@Suite("iOS parity fixes")
struct IosParityFixesTests {
    @Test func fableFiveDoesNotExposeClaudeFastMode() {
        #expect(!twModelUsesFastToggle("claude-fable-5"))
        #expect(!twModelUsesFastToggle("claude-fable-5-1m"))
        #expect(twModelUsesFastToggle("claude-opus-4-8-1m"))
    }

    @Test func transcriptTouchTrackerDoesNotInstallZeroDistanceDragOnIPad() {
        #expect(
            TranscriptTouchTrackingPolicy.usesZeroDistanceDragTracker(isPadInterface: false))
        #expect(
            !TranscriptTouchTrackingPolicy.usesZeroDistanceDragTracker(isPadInterface: true))
    }

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

        #expect(snapshots.isEmpty)
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
    @Test func threadSnapshotRequestWaitsForTaskCardScope() async throws {
        let model = makeRemoteSessionModel()

        model.requestThreadSnapshot("thread-1")
        #expect(model.lastActionMessage == nil)

        let snapshot = try decode(
            RemoteProjectionSnapshot.self,
            """
            {
              "projections":[
                {
                  "schemaVersion":1,
                  "source":"mac",
                  "kind":"taskCard",
                  "envelopeId":"task-card:thread-1",
                  "workspaceId":"ws-1",
                  "threadId":"thread-1",
                  "payload":{
                    "id":"thread-1",
                    "threadId":"thread-1",
                    "title":"Late card",
                    "status":"idle",
                    "provider":"cursor",
                    "workspaceId":"ws-1"
                  }
                }
              ]
            }
            """)

        model.applySnapshot(snapshot)
        for _ in 0..<5 {
            if model.lastActionMessage != nil { break }
            await Task.yield()
        }

        #expect(model.remoteScopeForThread("thread-1") == "ws-1")
        #expect(model.lastActionMessage != nil)
    }

    @MainActor
    @Test func threadDetailRefreshesMetadataOnlySnapshotWithHistory() throws {
        let row = try decode(
            RemoteThreadSnapshot.Row.self,
            #"{"id":"row-1","role":"user","kind":"message","preview":"hello","truncated":false}"#)

        #expect(ThreadSnapshotRequestPolicy.needsRefresh(nil) == true)
        #expect(
            ThreadSnapshotRequestPolicy.needsRefresh(
                RemoteThreadSnapshot(threadId: "thread-1", rows: [], totalRows: 2)) == true)
        #expect(
            ThreadSnapshotRequestPolicy.needsRefresh(
                RemoteThreadSnapshot(threadId: "thread-1", rows: nil, totalRows: nil)) == true)
        #expect(
            ThreadSnapshotRequestPolicy.needsRefresh(
                RemoteThreadSnapshot(threadId: "thread-1", rows: [], totalRows: 0)) == false)
        #expect(
            ThreadSnapshotRequestPolicy.needsRefresh(
                RemoteThreadSnapshot(
                    threadId: "thread-1",
                    rows: [row],
                    totalRows: 1)) == false)

        // Slice 5 (RC4): a wake-generation mismatch forces a refetch even over a
        // cached, non-empty transcript; matching generations fall through to the
        // existing row check (behaviour-identical to the default-arg callers).
        #expect(
            ThreadSnapshotRequestPolicy.needsRefresh(
                RemoteThreadSnapshot(threadId: "thread-1", rows: [row], totalRows: 1),
                wakeGeneration: 2, lastAppliedWakeGeneration: 1) == true)
        #expect(
            ThreadSnapshotRequestPolicy.needsRefresh(
                RemoteThreadSnapshot(threadId: "thread-1", rows: [row], totalRows: 1),
                wakeGeneration: 1, lastAppliedWakeGeneration: 1) == false)
    }

    // Slice 5 (RC4): notification-tap routing bumps the per-thread wake generation.
    @MainActor
    @Test func notificationTapWarmPathNavigatesAndBumpsGeneration() {
        let model = makeRemoteSessionModel()
        model.setPhaseForTesting(.connected)
        model.routeNotificationTargetForTesting("thread-1")
        #expect(model.navigationTarget == "thread-1")
        #expect(model.wakeRefreshGeneration["thread-1"] == 1)
        // A second tap advances the SAME thread's generation.
        model.routeNotificationTargetForTesting("thread-1")
        #expect(model.wakeRefreshGeneration["thread-1"] == 2)
        // A different thread has its own independent counter.
        model.routeNotificationTargetForTesting("thread-2")
        #expect(model.wakeRefreshGeneration["thread-2"] == 1)
    }

    @MainActor
    @Test func notificationTapColdPathDefersNavigationButStillBumpsGeneration() {
        let model = makeRemoteSessionModel()
        model.setPhaseForTesting(.idle)
        model.routeNotificationTargetForTesting("thread-9")
        // Cold path: navigation is restored on .established, not now — but the wake
        // generation is still bumped so the eventual landing refetches fresh.
        #expect(model.navigationTarget == nil)
        #expect(model.wakeRefreshGeneration["thread-9"] == 1)
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
    @Test func displayParticipantsAndMentionCandidatesSortShuffledWireOrder() throws {
        let state = try decode(
            RemoteEnsembleState.self,
            """
            {
              "threadId":"thread-1",
              "participants":[
                {"participantId":"p-charlie","provider":"claude","role":"Charlie","order":3,"status":"idle"},
                {"participantId":"p-dup-b","provider":"cursor","role":"DupB","order":2,"status":"idle"},
                {"participantId":"p-alpha","provider":"codex","role":"Alpha","order":1,"status":"idle"},
                {"participantId":"p-dup-a","provider":"grok","role":"DupA","order":2,"status":"idle"},
                {"participantId":"p-bravo","provider":"kimi","role":"Bravo","order":2,"status":"idle"}
              ],
              "roster":[
                {"id":"p-alpha","provider":"codex","role":"Alpha","enabled":true,"order":1},
                {"id":"p-bravo","provider":"kimi","role":"Bravo","enabled":true,"order":2},
                {"id":"p-dup-a","provider":"grok","role":"DupA","enabled":true,"order":2},
                {"id":"p-dup-b","provider":"cursor","role":"DupB","enabled":true,"order":2},
                {"id":"p-charlie","provider":"claude","role":"Charlie","enabled":true,"order":3}
              ]
            }
            """)

        let expectedIds = [
            "p-alpha", "p-bravo", "p-dup-a", "p-dup-b", "p-charlie",
        ]
        #expect(state.displayParticipants.map(\.participantId) == expectedIds)

        let mentionIds = twMentionCandidates(participants: state.displayParticipants).map(\.id)
        #expect(mentionIds == expectedIds)
    }

    @MainActor
    @Test func participantHealthRepairsGenericOllamaStampForLaguna() throws {
        let entry = try decode(
            RemoteThreadSnapshot.Row.ParticipantHealth.Entry.self,
            """
            {
              "participantId":"p-laguna",
              "provider":"ollama",
              "model":"laguna-xs-2.1:q8_0",
              "displayProviderLabel":"Ollama",
              "displayHueClass":"ollama",
              "role":"Laguna",
              "status":"ok"
            }
            """)

        let presentation = participantHealthEntryPresentation(entry)
        #expect(presentation.providerName == "Poolside")
        #expect(presentation.providerClass == "poolside")
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

    @Test func settledRowSpeakerSplitParsesParenthesizedModel() {
        let split = twSettledRowSpeakerSplit(from: "Gemini / Researcher (2.5 Flash)")
        #expect(split.label == "Gemini / Researcher")
        #expect(split.chip == "2.5 Flash")
    }

    @Test func settledRowSpeakerSplitKeepsFullLabelWithoutParens() {
        let split = twSettledRowSpeakerSplit(from: "Codex / Adversary2")
        #expect(split.label == "Codex / Adversary2")
        #expect(split.chip == nil)
    }

    @Test func settledRowSpeakerSplitFallsBackOnMalformedParens() {
        let split = twSettledRowSpeakerSplit(from: "Claude / WriteMain ()")
        #expect(split.label == "Claude / WriteMain ()")
        #expect(split.chip == nil)
    }

    @Test func settledRowSpeakerSplitHandlesEmptySpeaker() {
        #expect(twSettledRowSpeakerSplit(from: nil) == ("", nil))
        #expect(twSettledRowSpeakerSplit(from: "") == ("", nil))
    }

    @Test func settledRowModelChipDelegatesToSplit() {
        #expect(twSettledRowModelChip(from: "Claude / WriteMain (Fable 5)") == "Fable 5")
        #expect(twSettledRowModelChip(from: "Codex / Adversary2") == nil)
    }

    // ── Batch-1: chat-lifecycle + transcript bridge payloads (N2/T2) ──────
    // Host wires key on `appChatId`, NOT `threadId` — asserting the exact
    // keys guards against setThreadTitle copy/paste drift.

    private func decodedPayload(_ params: [String: Any]) throws -> [String: Any] {
        let base64 = try #require(params["payloadBase64"] as? String)
        let data = try #require(Data(base64Encoded: base64))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func togglePinChatPayloadUsesAppChatIdKey() throws {
        let payload = try decodedPayload(
            BridgeAction.togglePinChat(workspaceId: "ws-1", appChatId: "chat-9", pinned: true))
        #expect(payload["kind"] as? String == "togglePinChat")
        #expect(payload["appChatId"] as? String == "chat-9")
        #expect(payload["workspaceId"] as? String == "ws-1")
        #expect(payload["pinned"] as? Bool == true)
        #expect(payload["threadId"] == nil)
    }

    @Test func setChatArchivedPayloadShape() throws {
        let payload = try decodedPayload(
            BridgeAction.setChatArchived(workspaceId: "ws-1", appChatId: "chat-9", archived: false))
        #expect(payload["kind"] as? String == "setChatArchived")
        #expect(payload["appChatId"] as? String == "chat-9")
        #expect(payload["archived"] as? Bool == false)
        #expect(payload["threadId"] == nil)
    }

    @Test func chatMarkdownTranscriptPayloadShape() throws {
        let payload = try decodedPayload(
            BridgeAction.chatMarkdownTranscript(workspaceId: "global", appChatId: "chat-9"))
        #expect(payload["kind"] as? String == "chatMarkdownTranscript")
        #expect(payload["workspaceId"] as? String == "global")
        #expect(payload["appChatId"] as? String == "chat-9")
    }

    // ── Pass-2.5 Track-A: IF2 stream-pull suppression gate ─────────────────

    @Test func agentOutputPullSuppressedOnlyForVisibleStreamingThread() {
        // Suppress: agent-output + streaming + visible.
        #expect(
            RemoteSessionModel.shouldSuppressStreamRefreshPull(
                channel: "agent-output", isStreamingThread: true, isVisibleThread: true))
        // Keep the refresh in every other combination.
        #expect(
            !RemoteSessionModel.shouldSuppressStreamRefreshPull(
                channel: "agent-exit", isStreamingThread: true, isVisibleThread: true))
        #expect(
            !RemoteSessionModel.shouldSuppressStreamRefreshPull(
                channel: "agent-output", isStreamingThread: false, isVisibleThread: true))
        #expect(
            !RemoteSessionModel.shouldSuppressStreamRefreshPull(
                channel: "agent-output", isStreamingThread: true, isVisibleThread: false))
        #expect(
            !RemoteSessionModel.shouldSuppressStreamRefreshPull(
                channel: nil, isStreamingThread: true, isVisibleThread: true))
    }

    // ── Pass-3 Track-S3: on-demand snapshot pull suppression ───────────────

    @Test func onDemandSnapshotPullSuppressedOnlyForVisibleStreamingThread() {
        #expect(
            RemoteSessionModel.shouldSuppressOnDemandSnapshotPull(
                isStreamingThread: true, isVisibleThread: true))
        #expect(
            !RemoteSessionModel.shouldSuppressOnDemandSnapshotPull(
                isStreamingThread: false, isVisibleThread: true))
        #expect(
            !RemoteSessionModel.shouldSuppressOnDemandSnapshotPull(
                isStreamingThread: true, isVisibleThread: false))
    }

    @Test func onDemandSnapshotPullBypassesSuppressionForUserInitiatedPulls() {
        #expect(
            !RemoteSessionModel.shouldSuppressOnDemandSnapshotPull(
                isStreamingThread: true, isVisibleThread: true,
                bypassVisibleStreamSuppression: true))
    }

    /// iOS5 inventory: 25 user-action sites route through
    /// `scheduleThreadRefreshAfterUserAction`; runEvent uses passive gate + exit bypass.
    @Test func ios5ThreadRefreshSiteInventoryCount() {
        #expect(RemoteSessionModel.ios5UserInitiatedThreadRefreshSiteCount == 25)
    }

    // Slice 2 (RC1/RC2): requestFullProjection retry-decision policy.
    @Test func fullProjectionResyncSucceededOnlyForOkAck() {
        #expect(RemoteSessionModel.fullProjectionResyncSucceeded(AckResult(ok: true, result: nil, error: nil)))
        #expect(!RemoteSessionModel.fullProjectionResyncSucceeded(AckResult(ok: false, result: nil, error: "timeout")))
        #expect(!RemoteSessionModel.fullProjectionResyncSucceeded(nil))
    }

    @Test func fullProjectionResyncRetriesOnlyOnTransientFailureWhileConnected() {
        // nil ack (threw / no ack) while connected → retry.
        #expect(RemoteSessionModel.fullProjectionResyncShouldRetry(ack: nil, phase: .connected))
        // explicit timeout while connected → retry.
        #expect(
            RemoteSessionModel.fullProjectionResyncShouldRetry(
                ack: AckResult(ok: false, result: nil, error: "timeout"), phase: .connected))
        // success → no retry.
        #expect(
            !RemoteSessionModel.fullProjectionResyncShouldRetry(
                ack: AckResult(ok: true, result: nil, error: nil), phase: .connected))
        // hard reject (ok:false, non-timeout reason) → no retry.
        #expect(
            !RemoteSessionModel.fullProjectionResyncShouldRetry(
                ack: AckResult(ok: false, result: nil, error: "denied"), phase: .connected))
        // not connected → never retry, regardless of ack.
        #expect(!RemoteSessionModel.fullProjectionResyncShouldRetry(ack: nil, phase: .idle))
        #expect(
            !RemoteSessionModel.fullProjectionResyncShouldRetry(
                ack: AckResult(ok: false, result: nil, error: "timeout"), phase: .error("x")))
    }

    // Slice 3 (RC1): alive-wake rehydrate debounce.
    @MainActor
    @Test func shouldRehydrateOnAliveWakeDebounce() {
        let gap = RemoteSessionModel.aliveResyncMinGapMsForTesting
        // Never resynced → always allowed.
        #expect(RemoteSessionModel.shouldRehydrateOnAliveWake(nowMs: 1000, lastMs: 0, minGapMs: gap))
        // Inside the window → suppressed.
        #expect(
            !RemoteSessionModel.shouldRehydrateOnAliveWake(
                nowMs: 900 + gap - 1, lastMs: 900, minGapMs: gap))
        // Exactly at the boundary → allowed.
        #expect(
            RemoteSessionModel.shouldRehydrateOnAliveWake(
                nowMs: 1000 + gap, lastMs: 1000, minGapMs: gap))
        // Past the window → allowed.
        #expect(
            RemoteSessionModel.shouldRehydrateOnAliveWake(
                nowMs: 1000 + gap + 1, lastMs: 1000, minGapMs: gap))
    }

    // Slice 4 (RC3): empty-state presentation + grace-timer supersession.
    @Test func projectionEmptyPresentationSplitsPresumedFromConfirmed() {
        // Content present → no empty state, regardless of grace.
        #expect(
            RemoteSessionModel.projectionEmptyPresentation(
                hasWorkspaces: true, hasTaskCards: false, graceExpired: false) == nil)
        #expect(
            RemoteSessionModel.projectionEmptyPresentation(
                hasWorkspaces: false, hasTaskCards: true, graceExpired: true) == nil)
        // Empty + still in grace window → presumed (spinner + retry).
        #expect(
            RemoteSessionModel.projectionEmptyPresentation(
                hasWorkspaces: false, hasTaskCards: false, graceExpired: false) == .presumed)
        // Empty + grace expired → confirmed (setup copy + retry).
        #expect(
            RemoteSessionModel.projectionEmptyPresentation(
                hasWorkspaces: false, hasTaskCards: false, graceExpired: true) == .confirmed)
    }

    @Test func graceTimerOnlyConfirmsEmptyForItsOwnLiveConnection() {
        // Same attempt + connected → confirm.
        #expect(
            RemoteSessionModel.shouldConfirmProjectionEmpty(
                timerConnectAttempt: 3, currentConnectAttempt: 3, isConnected: true))
        // Superseded by a newer reconnect → do NOT latch.
        #expect(
            !RemoteSessionModel.shouldConfirmProjectionEmpty(
                timerConnectAttempt: 3, currentConnectAttempt: 4, isConnected: true))
        // Same attempt but no longer connected → do NOT latch.
        #expect(
            !RemoteSessionModel.shouldConfirmProjectionEmpty(
                timerConnectAttempt: 3, currentConnectAttempt: 3, isConnected: false))
    }

    @MainActor
    @Test func userInitiatedThreadRefreshSchedulesWhileVisibleStreaming() {
        let model = makeRemoteSessionModel()
        model.visibleThreadId = "thread-1"
        model.seedStreamingStateForTesting(threadId: "thread-1")
        model.scheduleThreadRefreshForTesting("thread-1")
        #expect(model.pendingThreadRefreshCountForTesting == 0)
        model.scheduleThreadRefreshAfterUserActionForTesting("thread-1")
        #expect(model.pendingThreadRefreshCountForTesting == 1)
        model.cancelPendingThreadRefreshForTesting()
    }

    @MainActor
    @Test func scheduleThreadRefreshBypassFiresThroughSuppressionGate() async throws {
        let model = makeRemoteSessionModel()
        model.visibleThreadId = "thread-1"
        model.seedStreamingStateForTesting(threadId: "thread-1")
        model.rememberThreadWorkspace("thread-1", workspaceId: "ws-1")
        model.scheduleThreadRefreshForTesting(
            "thread-1", debounceMs: 20_000_000, bypassVisibleStreamSuppression: true)
        // Poll (bounded), don't fix-sleep: the debounced pull resumes on the
        // MainActor, which a parallel @MainActor suite contends for, so a tight
        // budget flakes under load. Exits as soon as the pull lands.
        for _ in 0..<100 where model.threadSnapshotPullAttemptsForTesting == 0 {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(model.threadSnapshotPullAttemptsForTesting == 1)
        model.cancelPendingThreadRefreshForTesting()
    }

    @MainActor
    @Test func scheduleThreadRefreshSkippedForVisibleStreamingThread() async throws {
        let model = makeRemoteSessionModel()
        model.visibleThreadId = "thread-1"
        model.seedStreamingStateForTesting(threadId: "thread-1")
        model.scheduleThreadRefreshForTesting("thread-1")
        try await Task.sleep(nanoseconds: 500_000_000)
        #expect(model.pendingThreadRefreshCountForTesting == 0)
    }

    @MainActor
    @Test func scheduleThreadRefreshBypassesSuppressionForTerminalRefresh() async throws {
        let model = makeRemoteSessionModel()
        model.visibleThreadId = "thread-1"
        model.seedStreamingStateForTesting(threadId: "thread-1")
        model.scheduleThreadRefreshForTesting(
            "thread-1", bypassVisibleStreamSuppression: true)
        #expect(model.pendingThreadRefreshCountForTesting == 1)
        model.cancelPendingThreadRefreshForTesting()
    }

    // ── Pass-2.5 Track-A: IF1 full-snapshot coalescing ─────────────────────
    // ── Track-S S2 / IF3: off-MainActor decode inside coalescer ────────────

    private final class CoalescerTestLabel: @unchecked Sendable {
        var value = ""
    }

    private final class AppliedLabels: @unchecked Sendable {
        var values: [String] = []
    }

    @MainActor
    private func makeLabelTrackingCoalescer(
        applied: AppliedLabels,
        decodeThreadBox: DecodeThreadBox? = nil,
        slowFirstDecode: Bool = false
    ) -> (RemoteSessionModel.ProjectionSnapshotCoalescer, CoalescerTestLabel) {
        let label = CoalescerTestLabel()
        let decodeCalls = DecodeCallCounter()
        let emptySnapshot = Data(#"{"projections":[]}"#.utf8)
        let coalescer = RemoteSessionModel.ProjectionSnapshotCoalescer(
            decode: { data in
                if let decodeThreadBox {
                    decodeThreadBox.onMain = Thread.isMainThread
                }
                decodeCalls.count += 1
                if slowFirstDecode, decodeCalls.count == 1 {
                    Thread.sleep(forTimeInterval: 0.08)
                }
                label.value = String(decoding: data, as: UTF8.self)
                return try JSONDecoder().decode(DecodedProjectionSnapshot.self, from: emptySnapshot)
            },
            apply: { _ in applied.values.append(label.value) })
        return (coalescer, label)
    }

    private final class DecodeThreadBox: @unchecked Sendable {
        var onMain = false
    }

    private final class DecodeCallCounter: @unchecked Sendable {
        var count = 0
    }

    @MainActor
    @Test func projectionSnapshotBurstAppliesOnlyNewestEnvelope() async {
        let applied = AppliedLabels()
        let (coalescer, _) = makeLabelTrackingCoalescer(applied: applied)
        for n in 1...5 { coalescer.enqueue(Data("env-\(n)".utf8)) }
        await coalescer.drainForTesting()
        #expect(applied.values == ["env-5"])
        #expect(coalescer.applyCount == 1)
        coalescer.enqueue(Data("env-final".utf8))
        await coalescer.drainForTesting()
        #expect(applied.values == ["env-5", "env-final"])
        #expect(coalescer.applyCount == 2)
    }

    @MainActor
    @Test func coalescerBurstDecodesNewestOnlyOffMain() async {
        let applied = AppliedLabels()
        let decodeThreadBox = DecodeThreadBox()
        let (coalescer, _) = makeLabelTrackingCoalescer(
            applied: applied, decodeThreadBox: decodeThreadBox)
        for n in 1...5 { coalescer.enqueue(Data("env-\(n)".utf8)) }
        await coalescer.drainForTesting()
        #expect(applied.values == ["env-5"])
        #expect(coalescer.applyCount == 1)
        #expect(!decodeThreadBox.onMain)
    }

    @MainActor
    @Test func projectionSnapshotPreparesTwoHundredCardsOffMainAndPublishesOnce() async throws {
        let model = makeRemoteSessionModel()
        var taskCardPublishes = 0
        let subscription = model.$taskCards.dropFirst().sink { _ in
            taskCardPublishes += 1
        }
        let projections: [[String: Any]] = (0..<200).map { index in
            [
                "schemaVersion": 1,
                "source": "mac",
                "kind": "taskCard",
                "envelopeId": "task-\(index)",
                "threadId": "thread-\(index)",
                "payload": [
                    "id": "task-\(index)",
                    "threadId": "thread-\(index)",
                    "title": "Task \(index)",
                ],
            ]
        }
        let data = try JSONSerialization.data(withJSONObject: ["projections": projections])
        let decodeThreadBox = DecodeThreadBox()
        let coalescer = RemoteSessionModel.ProjectionSnapshotCoalescer(
            decode: { data in
                decodeThreadBox.onMain = Thread.isMainThread
                return try JSONDecoder().decode(DecodedProjectionSnapshot.self, from: data)
            },
            apply: { snapshot in model.applyDecodedSnapshot(snapshot) })

        coalescer.enqueue(data)
        await coalescer.drainForTesting()

        #expect(!decodeThreadBox.onMain)
        #expect(model.taskCards.count == 200)
        #expect(taskCardPublishes == 1)
        withExtendedLifetime(subscription) {}
    }

    @MainActor
    @Test func identicalFullSnapshotDoesNotRepublishSessionState() throws {
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
                  "envelopeId":"task-1",
                  "threadId":"thread-1",
                  "payload":{"id":"task-1","threadId":"thread-1","title":"Stable"}
                },
                {
                  "schemaVersion":1,
                  "source":"mac",
                  "kind":"threadSnapshot",
                  "envelopeId":"snapshot-1",
                  "threadId":"thread-1",
                  "payload":{"threadId":"thread-1","rows":[{"id":"r1","preview":"Stable"}]}
                }
              ]
            }
            """)
        model.applySnapshot(snapshot)
        var publishes = 0
        let subscription = model.objectWillChange.sink { _ in publishes += 1 }

        model.applySnapshot(snapshot)

        #expect(publishes == 0)
        withExtendedLifetime(subscription) {}
    }

    @MainActor
    @Test func fullSnapshotPublishesAllThreadAliasesInOneDictionaryUpdate() throws {
        let model = makeRemoteSessionModel()
        var publishes = 0
        let subscription = model.$threadSnapshots.dropFirst().sink { _ in publishes += 1 }
        let snapshot = try decode(
            RemoteProjectionSnapshot.self,
            """
            {
              "projections":[
                {
                  "schemaVersion":1,
                  "source":"mac",
                  "kind":"threadSnapshot",
                  "envelopeId":"snapshot-1",
                  "threadId":"thread-1",
                  "payload":{
                    "taskId":"task-1",
                    "threadId":"thread-1",
                    "rows":[{"id":"r1","preview":"One publish"}]
                  }
                }
              ]
            }
            """)

        model.applySnapshot(snapshot)

        #expect(model.threadSnapshots["task-1"]?.rows?.first?.preview == "One publish")
        #expect(model.threadSnapshots["thread-1"]?.rows?.first?.preview == "One publish")
        #expect(publishes == 1)
        withExtendedLifetime(subscription) {}
    }

    @MainActor
    @Test func coalescerAppliesTerminalStateAfterBurst() async {
        let applied = AppliedLabels()
        let (coalescer, _) = makeLabelTrackingCoalescer(applied: applied)
        for n in 1...4 { coalescer.enqueue(Data("env-\(n)".utf8)) }
        await coalescer.drainForTesting()
        coalescer.enqueue(Data("env-terminal".utf8))
        await coalescer.drainForTesting()
        #expect(applied.values == ["env-4", "env-terminal"])
        #expect(coalescer.applyCount == 2)
    }

    @MainActor
    @Test func coalescerSkipsStaleDecodeWhenNewerPending() async {
        let applied = AppliedLabels()
        let (coalescer, _) = makeLabelTrackingCoalescer(applied: applied, slowFirstDecode: true)
        coalescer.enqueue(Data("env-A".utf8))
        try? await Task.sleep(nanoseconds: 5_000_000)
        coalescer.enqueue(Data("env-B".utf8))
        await coalescer.drainForTesting()
        #expect(applied.values == ["env-B"])
        #expect(coalescer.applyCount == 1)
    }

    @MainActor
    @Test func coalescerResetDiscardsInFlightDecode() async {
        let applied = AppliedLabels()
        let (coalescer, _) = makeLabelTrackingCoalescer(applied: applied, slowFirstDecode: true)
        coalescer.enqueue(Data("env-A".utf8))
        try? await Task.sleep(nanoseconds: 5_000_000)
        coalescer.reset()
        await coalescer.drainForTesting()
        #expect(applied.values.isEmpty)
        #expect(coalescer.applyCount == 0)
    }

    @MainActor
    @Test func coalescerResetThenEnqueueDuringInFlightDecodeStillDrains() async {
        let applied = AppliedLabels()
        let (coalescer, _) = makeLabelTrackingCoalescer(applied: applied, slowFirstDecode: true)
        coalescer.enqueue(Data("env-A".utf8))
        try? await Task.sleep(nanoseconds: 5_000_000)
        coalescer.reset()
        coalescer.enqueue(Data("env-B".utf8))
        await coalescer.drainForTesting()
        #expect(applied.values == ["env-B"])
        #expect(coalescer.applyCount == 1)
    }

    @MainActor
    @Test func coalescerDecodeFailureContinuesDrain() async {
        let applied = AppliedLabels()
        let label = CoalescerTestLabel()
        let goodSnapshot = Data(
            #"{"projections":[{"schemaVersion":1,"source":"mac","kind":"threadSnapshot","envelopeId":"t1","threadId":"thread-1","payload":{"threadId":"thread-1","rows":[{"id":"r1","preview":"from-snapshot"}]}}]}"#
                .utf8)
        let coalescer = RemoteSessionModel.ProjectionSnapshotCoalescer(
            decode: { data in
                let token = String(decoding: data, as: UTF8.self)
                if token == "bad" { throw NSError(domain: "test", code: 1) }
                label.value = token
                return try JSONDecoder().decode(DecodedProjectionSnapshot.self, from: goodSnapshot)
            },
            apply: { _ in applied.values.append(label.value) })
        coalescer.enqueue(Data("bad".utf8))
        await coalescer.drainForTesting()
        coalescer.enqueue(Data("good".utf8))
        await coalescer.drainForTesting()
        #expect(applied.values == ["good"])
        #expect(coalescer.applyCount == 1)
    }

    @MainActor
    @Test func deltaOrderingPreservedDuringSnapshotDecode() async throws {
        let model = makeRemoteSessionModel()
        let baseline = try decode(
            RemoteProjectionSnapshot.self,
            """
            {
              "projections":[
                {
                  "schemaVersion":1,
                  "source":"mac",
                  "kind":"threadSnapshot",
                  "envelopeId":"thread-1",
                  "threadId":"thread-1",
                  "payload":{
                    "threadId":"thread-1",
                    "rows":[{"id":"r1","preview":"baseline"}]
                  }
                }
              ]
            }
            """)
        model.applySnapshot(baseline)
        let deltaEnvelope = try decode(
            RemoteProjectionEnvelope.self,
            """
            {
              "schemaVersion":1,
              "source":"mac",
              "kind":"threadSnapshot",
              "envelopeId":"thread-1-delta",
              "threadId":"thread-1",
              "payload":{
                "threadId":"thread-1",
                "rows":[{"id":"r1","preview":"from-delta"}]
              }
            }
            """)
        model.merge(envelope: deltaEnvelope)
        #expect(model.threadSnapshots["thread-1"]?.rows?.first?.preview == "from-delta")

        let staleFull = try JSONEncoder().encode(
            try decode(
                RemoteProjectionSnapshot.self,
                """
                {
                  "projections":[
                    {
                      "schemaVersion":1,
                      "source":"mac",
                      "kind":"threadSnapshot",
                      "envelopeId":"thread-1-full",
                      "threadId":"thread-1",
                      "payload":{
                        "threadId":"thread-1",
                        "rows":[{"id":"r1","preview":"stale-full"}]
                      }
                    }
                  ]
                }
                """))
        let midDecodeDelta = try decode(
            RemoteProjectionEnvelope.self,
            """
            {
              "schemaVersion":1,
              "source":"mac",
              "kind":"threadSnapshot",
              "envelopeId":"thread-1-mid",
              "threadId":"thread-1",
              "payload":{
                "threadId":"thread-1",
                "rows":[
                  {"id":"r1","preview":"from-delta"},
                  {"id":"r2","preview":"delta-only-row"}
                ]
              }
            }
            """)
        let decodeCalls = DecodeCallCounter()
        let coalescer = RemoteSessionModel.ProjectionSnapshotCoalescer(
            decode: { data in
                decodeCalls.count += 1
                if decodeCalls.count == 1 { Thread.sleep(forTimeInterval: 0.08) }
                return try JSONDecoder().decode(DecodedProjectionSnapshot.self, from: data)
            },
            apply: { snapshot in model.applyDecodedSnapshot(snapshot) })
        coalescer.enqueue(staleFull)
        try? await Task.sleep(nanoseconds: 5_000_000)
        model.merge(envelope: midDecodeDelta)
        await coalescer.drainForTesting()
        let previews = model.threadSnapshots["thread-1"]?.rows?.map(\.preview) ?? []
        #expect(previews.contains("delta-only-row"))
    }

    // ── Pass-2.5: TV thinking wire decode + viewport logic ─────────────────

    @Test func thinkingFieldDecodesFromWireRow() throws {
        let row = try decode(
            RemoteThreadSnapshot.Row.self,
            """
            {
              "id": "r1",
              "role": "assistant",
              "preview": "Answer body",
              "thinking": {
                "title": "Thinking",
                "preview": "step 1... step 2...",
                "truncated": true,
                "toolName": "_thinking",
                "status": "done"
              }
            }
            """)
        #expect(row.thinking?.preview == "step 1... step 2...")
        #expect(row.thinking?.truncated == true)
        // Older-Mac rows without the field stay decodable.
        let legacy = try decode(
            RemoteThreadSnapshot.Row.self, #"{"id":"r2","preview":"x"}"#)
        #expect(legacy.thinking == nil)
    }

    @Test func thinkingViewportChipAndWireExpansionRules() {
        #expect(ThinkingViewportView.chipTitle(expanded: false, isExpanding: false) == "Show thinking")
        #expect(ThinkingViewportView.chipTitle(expanded: true, isExpanding: false) == "Hide thinking")
        #expect(ThinkingViewportView.chipTitle(expanded: true, isExpanding: true) == "Loading…")
        // Wire fetch only on expand of a host-truncated trace.
        #expect(ThinkingViewportView.needsWireExpansion(expanding: true, truncated: true))
        #expect(!ThinkingViewportView.needsWireExpansion(expanding: true, truncated: false))
        #expect(!ThinkingViewportView.needsWireExpansion(expanding: true, truncated: nil))
        #expect(!ThinkingViewportView.needsWireExpansion(expanding: false, truncated: true))
    }

    // ── Batch-1: N1 search-scope chips ─────────────────────────────────────

    @Test func homeSearchProviderMatchCoversDivergentVisibleLabels() {
        // N1 matches BOTH the raw wire id and the visible label — the query
        // "deep re" hits the rendered "Deep Reinforce" but not the raw
        // "deep-reinforce" id (Adversary2 Batch-1 finding).
        let label = TWTheme.providerLabel("deep-reinforce")
        #expect(label == "Deep Reinforce")
        #expect(!"deep-reinforce".localizedStandardContains("deep re"))
        #expect(label.localizedStandardContains("deep re"))
    }

    @Test func homeSearchRankerMatchesVisibleProviderLabelThroughRealPath() throws {
        // Track-S R5: exercise HomeSearchRanker (same logic as HomeView.searchResults),
        // not just TWTheme.providerLabel in isolation.
        let target = try remoteTaskCard(
            #"{"id":"chat-dr","title":"Auth refactor","provider":"deep-reinforce","updatedAt":"2026-07-07T12:00:00Z"}"#)
        let other = try remoteTaskCard(
            #"{"id":"chat-cx","title":"Unrelated chat","provider":"codex","updatedAt":"2026-07-07T11:00:00Z"}"#)
        let results = HomeSearchRanker.rankedResults(
            query: "deep re",
            scope: .active,
            taskCards: [target, other],
            workflows: [],
            workspaceName: { _ in nil })
        #expect(results.map(\.id) == ["chat-dr"])
        #expect(!"deep-reinforce".localizedStandardContains("deep re"))
    }

    @Test func homeSearchRankerStillMatchesRawProviderId() throws {
        let card = try remoteTaskCard(
            #"{"id":"chat-codex","title":"Planner thread","provider":"codex","updatedAt":"2026-07-07T12:00:00Z"}"#)
        let results = HomeSearchRanker.rankedResults(
            query: "codex",
            scope: .active,
            taskCards: [card],
            workflows: [],
            workspaceName: { _ in nil })
        #expect(results.map(\.id) == ["chat-codex"])
    }

    @MainActor
    @Test func markdownLiteBlockCacheLRUTouchOnHitRefreshesRecency() {
        // Track-S R4: after filling the cache, touching the oldest entry must
        // keep it resident when a new key forces eviction (FIFO would drop it).
        MarkdownLite._resetBlockCacheForTesting()
        for index in 0..<96 {
            MarkdownLite._touchBlockCacheForTesting(text: "block-\(index)")
        }
        MarkdownLite._touchBlockCacheForTesting(text: "block-0")
        MarkdownLite._touchBlockCacheForTesting(text: "block-96")
        #expect(MarkdownLite._blockCacheContainsForTesting(text: "block-0"))
        #expect(!MarkdownLite._blockCacheContainsForTesting(text: "block-1"))
        MarkdownLite._resetBlockCacheForTesting()
    }

    @MainActor
    @Test func markdownLiteBlockCacheKeyRetainsParticipantsSignature() throws {
        // Landmine ⑥: cache key must include participants or mention re-tint goes stale.
        MarkdownLite._resetBlockCacheForTesting()
        let participantsA = [
            try decode(
                RemoteEnsembleState.Participant.self,
                #"{"participantId":"p-a","provider":"codex","role":"Alpha","order":1}"#)
        ]
        let participantsB = [
            try decode(
                RemoteEnsembleState.Participant.self,
                #"{"participantId":"p-b","provider":"claude","role":"Bravo","order":1}"#)
        ]
        MarkdownLite._touchBlockCacheForTesting(text: "same body", participants: participantsA)
        MarkdownLite._touchBlockCacheForTesting(text: "same body", participants: participantsB)
        #expect(MarkdownLite._blockCacheContainsForTesting(text: "same body", participants: participantsA))
        #expect(MarkdownLite._blockCacheContainsForTesting(text: "same body", participants: participantsB))
        MarkdownLite._resetBlockCacheForTesting()
    }

    @Test func homeSearchScopeChipsCoverArchivedDiscoverability() {
        #expect(HomeSearchScope.allCases == [.active, .all])
        #expect(HomeSearchScope.all.label == "All incl. Archived")
        #expect(HomeSearchScope.active.label == "Active")
    }

    @MainActor
    @Test func quietGitSnapshotRefreshPublishesToSharedCache() async {
        // The composer's event-driven git refreshes (run-finish, foregrounding,
        // diff-sheet open) must land in the SHARED gitSnapshots cache — the one
        // ChangesAttachedRow and the compact pill both render from — not in
        // pill-local state, or the focused changes rows go stale while the
        // blurred pill shows fresh counts.
        let model = makeRemoteSessionModel()
        model.enterDemoMode()
        #expect(model.gitSnapshots["quiet-refresh-ws"] == nil)
        await model.refreshGitSnapshotCacheQuietly(workspaceId: "quiet-refresh-ws")
        #expect(model.gitSnapshots["quiet-refresh-ws"]?.counts?.changed == 3)
        #expect(model.gitSnapshots["quiet-refresh-ws"]?.branch == "feat/auth-refactor")
    }

    @MainActor
    @Test func quietGitSnapshotRefreshToleratesMissingWorkspaceAndConnection() async {
        // Fired opportunistically, so it must no-op — never throw, never store
        // garbage — with no workspace id or no live bridge connection.
        let model = makeRemoteSessionModel()
        await model.refreshGitSnapshotCacheQuietly(workspaceId: nil)
        await model.refreshGitSnapshotCacheQuietly(workspaceId: "")
        await model.refreshGitSnapshotCacheQuietly(workspaceId: "ws")
        #expect(model.gitSnapshots.isEmpty)
    }

    // ── Pass-4 Track-B2: phone watch assertion ─────────────────────────────

    @Test func setWatchedThreadPayloadShapeWithThreadId() throws {
        let payload = try decodedPayload(BridgeAction.setWatchedThread(appChatId: "chat-42"))
        #expect(payload["kind"] as? String == "setWatchedThread")
        #expect(payload["appChatId"] as? String == "chat-42")
    }

    @Test func setWatchedThreadPayloadShapeWithNull() throws {
        let payload = try decodedPayload(BridgeAction.setWatchedThread(appChatId: nil))
        #expect(payload["kind"] as? String == "setWatchedThread")
        #expect(payload["appChatId"] is NSNull)
    }

    @MainActor
    @Test func visibleThreadIdChangeRecordsWatchAssertion() {
        let model = makeRemoteSessionModel()
        model.visibleThreadId = "thread-a"
        #expect(model.lastWatchedThreadAssertionAppChatIdForTesting == "thread-a")
        model.visibleThreadId = nil
        #expect(model.lastWatchedThreadAssertionAppChatIdForTesting == Optional<String>.none)
    }

    @MainActor
    @Test func scenePhaseBackgroundSendsNullWatchAssertion() {
        let model = makeRemoteSessionModel()
        model.visibleThreadId = "thread-a"
        model.handleScenePhaseWatchAssertion(isActive: false)
        #expect(model.lastWatchedThreadAssertionAppChatIdForTesting == nil)
        model.handleScenePhaseWatchAssertion(isActive: true)
        #expect(model.lastWatchedThreadAssertionAppChatIdForTesting == "thread-a")
    }

    // ── Pass-4 Track-S3: streaming publish coalesce ────────────────────────

    private func streamingTokenLine(_ text: String) -> String {
        "{\"type\":\"token\",\"text\":\"\(text)\"}"
    }

    @MainActor
    @Test func firstDeltaPublishesImmediately() {
        let model = makeRemoteSessionModel()
        model.appendStreamingDeltasForTesting(
            threadId: "t1", data: streamingTokenLine("hello"), runId: "run-1", provider: "codex")
        #expect(model.streamingTexts["t1"] == "hello")
        #expect(model.streamingRunIds["t1"] == "run-1")
        #expect(model.streamingProviders["t1"] == "codex")
        #expect(model.streamingPublishInvocationCountForTesting == 1)
    }

    @MainActor
    @Test func burstWithinWindowPublishesOnceConcatenated() async throws {
        let model = makeRemoteSessionModel()
        model.appendStreamingDeltasForTesting(
            threadId: "t1", data: streamingTokenLine("a"), runId: "run-1")
        #expect(model.streamingPublishInvocationCountForTesting == 1)
        model.appendStreamingDeltasForTesting(
            threadId: "t1", data: streamingTokenLine("b"), runId: "run-1")
        model.appendStreamingDeltasForTesting(
            threadId: "t1", data: streamingTokenLine("c"), runId: "run-1")
        #expect(model.streamingPublishInvocationCountForTesting == 1)
        #expect(model.streamingTexts["t1"] == "a")
        try await Task.sleep(nanoseconds: StreamingPublishGate.streamingPublishCoalesceWindowNs + 70_000_000)
        #expect(model.streamingTexts["t1"] == "abc")
        #expect(model.streamingPublishInvocationCountForTesting == 2)
    }

    @MainActor
    @Test func trailingFlushCarriesFinalText() async throws {
        let model = makeRemoteSessionModel()
        model.appendStreamingDeltasForTesting(
            threadId: "t1", data: streamingTokenLine("one"), runId: "run-1")
        model.appendStreamingDeltasForTesting(
            threadId: "t1", data: streamingTokenLine("two"), runId: "run-1")
        try await Task.sleep(nanoseconds: StreamingPublishGate.streamingPublishCoalesceWindowNs + 70_000_000)
        #expect(model.streamingTexts["t1"] == "onetwo")
    }

    @MainActor
    @Test func exitBypassesWindowPublishesBeforeCleanup() {
        let model = makeRemoteSessionModel()
        model.appendStreamingDeltasForTesting(
            threadId: "t1", data: streamingTokenLine("part"), runId: "run-1")
        model.appendStreamingDeltasForTesting(
            threadId: "t1", data: streamingTokenLine("-final"), runId: "run-1")
        #expect(model.streamingTexts["t1"] == "part")
        model.flushStreamingPublishForTesting(threadId: "t1")
        #expect(model.streamingTexts["t1"] == "part-final")
    }

    @MainActor
    @Test func windowFireAfterExitCleanupIsNoOp() async throws {
        let model = makeRemoteSessionModel()
        model.appendStreamingDeltasForTesting(
            threadId: "t1", data: streamingTokenLine("x"), runId: "run-1")
        model.appendStreamingDeltasForTesting(
            threadId: "t1", data: streamingTokenLine("y"), runId: "run-1")
        model.flushStreamingPublishForTesting(threadId: "t1")
        let countAfterExit = model.streamingPublishInvocationCountForTesting
        model.resetStreamingPublishGateForTesting(threadId: "t1")
        try await Task.sleep(nanoseconds: StreamingPublishGate.streamingPublishCoalesceWindowNs + 70_000_000)
        #expect(model.streamingPublishInvocationCountForTesting == countAfterExit)
    }

    @MainActor
    @Test func perThreadGateIsolation() async throws {
        let model = makeRemoteSessionModel()
        model.appendStreamingDeltasForTesting(
            threadId: "t1", data: streamingTokenLine("a"), runId: "run-1")
        model.appendStreamingDeltasForTesting(
            threadId: "t2", data: streamingTokenLine("b"), runId: "run-2")
        #expect(model.streamingTexts["t1"] == "a")
        #expect(model.streamingTexts["t2"] == "b")
        model.appendStreamingDeltasForTesting(
            threadId: "t1", data: streamingTokenLine("c"), runId: "run-1")
        try await Task.sleep(nanoseconds: StreamingPublishGate.streamingPublishCoalesceWindowNs + 70_000_000)
        #expect(model.streamingTexts["t1"] == "ac")
        #expect(model.streamingTexts["t2"] == "b")
    }

    @MainActor
    @Test func appendOrderPreservedExactly() async throws {
        let model = makeRemoteSessionModel()
        for ch in ["f", "i", "r", "s", "t"] {
            model.appendStreamingDeltasForTesting(
                threadId: "t1", data: streamingTokenLine(ch), runId: "run-1")
        }
        try await Task.sleep(nanoseconds: StreamingPublishGate.streamingPublishCoalesceWindowNs + 70_000_000)
        #expect(model.streamingTexts["t1"] == "first")
    }

    @MainActor
    @Test func stalenessBoundRespected() async throws {
        let model = makeRemoteSessionModel()
        let start = ContinuousClock.now
        model.appendStreamingDeltasForTesting(
            threadId: "t1", data: streamingTokenLine("z"), runId: "run-1")
        model.appendStreamingDeltasForTesting(
            threadId: "t1", data: streamingTokenLine("!"), runId: "run-1")
        try await Task.sleep(nanoseconds: StreamingPublishGate.streamingPublishCoalesceWindowNs + 70_000_000)
        #expect(model.streamingTexts["t1"] == "z!")
        let elapsed = start.duration(to: .now)
        #expect(elapsed <= .milliseconds(200))
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
