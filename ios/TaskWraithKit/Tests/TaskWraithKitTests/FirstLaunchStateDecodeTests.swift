import Foundation
import Testing

@testable import TaskWraithKit

@Suite("First-launch state decode")
struct FirstLaunchStateDecodeTests {
    @Test("decodes redacted first-launch state message")
    func decodesStateMessage() throws {
        let json = """
        {"state":{"schemaVersion":1,"generatedAt":"2026-06-21T18:02:00.000Z",
         "notifications":[{"id":"gemini-retired","kind":"provider-retired","title":"Gemini retired","body":"Existing chats remain visible.","tone":"danger","dismissible":true}],
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
        #expect(message.state.workspace?.visibleCount == 2)
        #expect(message.state.workspace?.capabilities.fileWrite == false)
        #expect(message.state.providerCards.map(\.id) == ["codex", "ollama"])
        #expect(message.state.providerCards.contains { $0.id == "gemini" } == false)
        #expect(message.state.providerCards.first?.usageWindows.first?.usedPercent == 28)
        #expect(message.state.ollamaModelCommands.first?.command == "ollama run qwen3:4b-instruct")
    }
}
