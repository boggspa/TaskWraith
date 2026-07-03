import Foundation
import Testing

@testable import TaskWraithKit

@Suite("First-launch state decode")
struct FirstLaunchStateDecodeTests {
    @Test("decodes redacted first-launch state message")
    func decodesStateMessage() throws {
        let json = """
        {"state":{"schemaVersion":1,"generatedAt":"2026-06-21T18:02:00.000Z",
         "notifications":[
          {"id":"gemini-retired","kind":"provider-retired","title":"Gemini retired","body":"Existing chats remain visible.","tone":"danger","dismissible":true},
          {"id":"claude-sonnet-5-2026-06-30","kind":"addition","title":"Claude Sonnet 5 is available.","body":"Adaptive thinking and 1M context are available.","tone":"default","accent":"claude","dismissible":true},
          {"id":"ensemble-composer-toggle-2026-07-03","kind":"feature","title":"Ensemble starts from new drafts now.","body":"Use the Ensemble glyph in the composer bottom row.","tone":"default","accent":"ensemble","icon":"ensemble","dismissible":true},
          {"id":"antigravity-not-planned-2026-06-26","kind":"info","title":"AntiGravity will not be added.","body":"TaskWraith will not integrate Google AntiGravity as a Gemini replacement because it would require unsupported credential use and would not fit TaskWraith’s provider model.","tone":"default","dismissible":true}
         ],
         "workspace":{"visibleCount":2,"totalCount":4,"runningCount":1,"hasVisibleWorkspaces":true,"capabilities":{"monitor":true,"approve":true,"answer":true,"startTurn":true,"steer":true,"fileRead":true,"fileWrite":false}},
         "providerCards":[
          {"id":"codex","label":"Codex","optional":false,"statusKind":"ready","statusText":"Ready on Mac","detail":"Codex is available.","setupHint":"Run codex login on Mac.","setupCommands":[{"id":"codex","label":"Codex","command":"npm i -g @openai/codex","source":"OpenAI"}],"usageWindows":[{"id":"codex-5h","label":"Current session","usedPercent":28,"resetAt":"2026-06-21T22:00:00.000Z"}],"usageGeneratedAt":"2026-06-21T18:01:00.000Z"},
          {"id":"ollama","label":"Ollama","optional":true,"statusKind":"localReady","statusText":"Local Ollama ready","detail":"Local runtime ready.","setupHint":"Pull a model on Mac.","setupCommands":[],"usageWindows":[]}
         ],
         "setupCommands":[{"id":"codex","label":"Codex","command":"npm i -g @openai/codex","source":"OpenAI"}],
         "ollamaModelCommands":[{"id":"qwen3:4b-instruct","label":"Qwen 3","command":"ollama run qwen3:4b-instruct"}]}}
        """
        let message = try JSONDecoder().decode(FirstLaunchStateMessage.self, from: Data(json.utf8))

        #expect(message.state.schemaVersion == 1)
        #expect(message.state.notifications.first?.tone == "danger")
        #expect(message.state.notifications.first?.accent == nil)
        #expect(message.state.notifications.first?.icon == nil)
        #expect(message.state.notifications.count == 4)
        #expect(message.state.notifications[1].id == "claude-sonnet-5-2026-06-30")
        #expect(message.state.notifications[1].accent == "claude")
        #expect(message.state.notifications[2].id == "ensemble-composer-toggle-2026-07-03")
        #expect(message.state.notifications[2].accent == "ensemble")
        #expect(message.state.notifications[2].icon == "ensemble")
        #expect(message.state.notifications.last?.id == "antigravity-not-planned-2026-06-26")
        #expect(message.state.notifications.last?.tone == "default")
        #expect(message.state.notifications.last?.accent == nil)
        #expect(message.state.notifications.last?.title == "AntiGravity will not be added.")
        #expect(message.state.workspace?.visibleCount == 2)
        #expect(message.state.workspace?.capabilities.fileWrite == false)
        #expect(message.state.providerCards.map(\.id) == ["codex", "ollama"])
        #expect(message.state.providerCards.contains { $0.id == "gemini" } == false)
        #expect(message.state.providerCards.first?.usageWindows.first?.usedPercent == 28)
        #expect(message.state.ollamaModelCommands.first?.command == "ollama run qwen3:4b-instruct")
    }
}
