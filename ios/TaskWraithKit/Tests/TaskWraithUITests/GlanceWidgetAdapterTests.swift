import Foundation
import Testing
import TaskWraithKit
@testable import TaskWraithUI

@Suite("Glance widget adapter")
struct GlanceWidgetAdapterTests {
    private func card(
        status: String,
        provider: String = "codex",
        chatKind: String? = nil,
        updatedAt: String = "2024-01-15T10:30:00.000Z"
    ) throws -> RemoteTaskCard {
        let chatKindFragment = chatKind.map { ",\"chatKind\":\"\($0)\"" } ?? ""
        let json = """
            {"id":"test-\(status)-\(provider)","status":"\(status)",\
             "provider":"\(provider)"\(chatKindFragment),\
             "updatedAt":"\(updatedAt)"}
            """
        return try JSONDecoder().decode(RemoteTaskCard.self, from: Data(json.utf8))
    }

    @Test @MainActor
    func awaitingApprovalRowUsesAttentionTint() throws {
        let row = RemoteSessionModel.glanceWidgetRow(for: try card(status: "awaitingApproval"))
        #expect(row.status == "awaitingApproval")
        #expect(row.tintHex == TWTheme.statusAttentionHex)
    }

    @Test @MainActor
    func awaitingQuestionRowUsesAttentionTint() throws {
        let row = RemoteSessionModel.glanceWidgetRow(for: try card(status: "awaitingQuestion"))
        #expect(row.status == "awaitingQuestion")
        #expect(row.tintHex == TWTheme.statusAttentionHex)
    }

    @Test @MainActor
    func runningRowUsesProviderAccent() throws {
        let row = RemoteSessionModel.glanceWidgetRow(for: try card(status: "running", provider: "claude"))
        #expect(row.tintHex == TWTheme.providerAccentHex("claude"))
    }

    @Test @MainActor
    func queuedRowIsNeutral() throws {
        let row = RemoteSessionModel.glanceWidgetRow(for: try card(status: "queued"))
        #expect(row.status == "queued")
        #expect(row.tintHex == nil)
    }

    @Test @MainActor
    func cancelledRowIsNeutral() throws {
        let row = RemoteSessionModel.glanceWidgetRow(for: try card(status: "cancelled"))
        #expect(row.status == "cancelled")
        #expect(row.tintHex == nil)
    }

    @Test @MainActor
    func ensembleRowUsesEnsembleLabelAndAccent() throws {
        let row = RemoteSessionModel.glanceWidgetRow(
            for: try card(status: "running", provider: "pi", chatKind: "ensemble"))
        #expect(row.providerLabel == "Ensemble")
        #expect(row.tintHex == TWTheme.providerAccentHex("ensemble"))
    }

    @Test @MainActor
    func sortRanksNeedsYouFirstThenActiveThenTerminal() {
        #expect(RemoteSessionModel.glanceWidgetSortRank("awaitingApproval") == 0)
        #expect(RemoteSessionModel.glanceWidgetSortRank("awaitingQuestion") == 0)
        #expect(RemoteSessionModel.glanceWidgetSortRank("queued") == 1)
        #expect(RemoteSessionModel.glanceWidgetSortRank("running") == 1)
        #expect(RemoteSessionModel.glanceWidgetSortRank("success") == 2)
        #expect(RemoteSessionModel.glanceWidgetSortRank("failed") == 2)
        #expect(RemoteSessionModel.glanceWidgetSortRank("cancelled") == 2)
    }
}
