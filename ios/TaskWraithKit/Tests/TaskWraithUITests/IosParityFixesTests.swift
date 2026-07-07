import Foundation
import Testing
import TaskWraithKit

@testable import TaskWraithUI

@Suite("iOS parity fixes")
struct IosParityFixesTests {
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

    // ── Pass-2.5 Track-A: IF1 full-snapshot coalescing ─────────────────────

    @MainActor
    @Test func projectionSnapshotBurstAppliesOnlyNewestEnvelope() {
        var applied: [String] = []
        let coalescer = RemoteSessionModel.ProjectionSnapshotCoalescer { data in
            applied.append(String(decoding: data, as: UTF8.self))
        }
        // Burst of 5 queued full snapshots before any drain runs.
        for n in 1...5 { coalescer.enqueue(Data("env-\(n)".utf8)) }
        coalescer.drain()
        #expect(applied == ["env-5"])
        #expect(coalescer.applyCount == 1)
        // Terminal-state safety: a late envelope after the drain still applies.
        coalescer.enqueue(Data("env-final".utf8))
        coalescer.drain()
        #expect(applied == ["env-5", "env-final"])
        // Drain with nothing pending is a no-op, not a re-apply.
        coalescer.drain()
        #expect(coalescer.applyCount == 2)
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
