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
          {"id":"ensemble-composer-toggle-2026-07-03","kind":"feature","title":"Ensemble starts from new drafts now.","body":"Use the Ensemble glyph in the composer bottom row.","tone":"default","accent":"ensemble","icon":"ensemble","dismissible":true}
         ],
         "workspace":{"visibleCount":2,"totalCount":4,"runningCount":1,"hasVisibleWorkspaces":true,"capabilities":{"monitor":true,"approve":true,"answer":true,"startTurn":true,"steer":true,"fileRead":true,"fileWrite":false}},
         "providerCards":[
          {"id":"codex","label":"Codex","optional":false,"statusKind":"ready","statusText":"Ready on Mac","detail":"Codex is available.","setupHint":"Run codex login on Mac.","setupCommands":[{"id":"codex","label":"Codex","command":"npm i -g @openai/codex","source":"OpenAI"}],"usageWindows":[{"id":"codex-5h","label":"Current session","usedPercent":28,"resetAt":"2026-06-21T22:00:00.000Z"}],"usageGeneratedAt":"2026-06-21T18:01:00.000Z"},
          {"id":"ollama","label":"Ollama","optional":true,"statusKind":"localReady","statusText":"Local Ollama ready","detail":"Local runtime ready.","setupHint":"Pull a model on Mac.","setupCommands":[],"usageWindows":[]}
         ],
         "setupCommands":[{"id":"codex","label":"Codex","command":"npm i -g @openai/codex","source":"OpenAI"}],
         "ollamaModelCommands":[
          {"id":"qwen3:4b-instruct","label":"Qwen 3","command":"ollama run qwen3:4b-instruct"},
          {"id":"llama3.1:8b","label":"Llama 3.1 (8B Param)","command":"ollama run llama3.1:8b"},
          {"id":"deepseek-r1:8b","label":"DeepSeek R1 (8B Param)","command":"ollama run deepseek-r1:8b"},
          {"id":"rnj-1","label":"Rnj-1 (8B Param; Ollama 0.13.3+)","command":"ollama run rnj-1"},
          {"id":"glm-4.7-flash:q4_K_M","label":"GLM-4.7-Flash (30B-A3B Q4; Ollama 0.15.0+)","command":"ollama run glm-4.7-flash:q4_K_M"},
          {"id":"north-mini-code-1.0:q4_K_M","label":"North Mini Code 1.0 (30B-A3B Q4; Ollama 0.30.10+)","command":"ollama run north-mini-code-1.0:q4_K_M"},
          {"id":"llama3.2:3b","label":"Llama 3.2 (3B Param)","command":"ollama run llama3.2:3b"}
         ]}}
        """
        let message = try JSONDecoder().decode(FirstLaunchStateMessage.self, from: Data(json.utf8))

        #expect(message.state.schemaVersion == 1)
        #expect(message.state.notifications.first?.tone == "danger")
        #expect(message.state.notifications.first?.accent == nil)
        #expect(message.state.notifications.first?.icon == nil)
        #expect(message.state.notifications.count == 3)
        #expect(message.state.notifications[1].id == "claude-sonnet-5-2026-06-30")
        #expect(message.state.notifications[1].accent == "claude")
        #expect(message.state.notifications[2].id == "ensemble-composer-toggle-2026-07-03")
        #expect(message.state.notifications[2].accent == "ensemble")
        #expect(message.state.notifications[2].icon == "ensemble")
        #expect(message.state.workspace?.visibleCount == 2)
        #expect(message.state.workspace?.capabilities.fileWrite == false)
        #expect(message.state.providerCards.map(\.id) == ["codex", "ollama"])
        #expect(message.state.providerCards.contains { $0.id == "gemini" } == false)
        #expect(message.state.providerCards.first?.usageWindows.first?.usedPercent == 28)
        #expect(message.state.ollamaModelCommands.first?.command == "ollama run qwen3:4b-instruct")
        let commands = Set(message.state.ollamaModelCommands.map(\.command))
        #expect(commands.contains("ollama run llama3.1:8b"))
        #expect(commands.contains("ollama run deepseek-r1:8b"))
        #expect(commands.contains("ollama run rnj-1"))
        #expect(commands.contains("ollama run glm-4.7-flash:q4_K_M"))
        #expect(commands.contains("ollama run north-mini-code-1.0:q4_K_M"))
        #expect(commands.contains("ollama run llama3.2:3b"))
    }

    @Test("decodes a \"New Additions\" notice's grouped provider/model content")
    func decodesNewAdditionsGroups() throws {
        let json = """
        {"id":"new-additions-2026-07-17","kind":"addition","title":"New Additions","body":"Summary fallback.","tone":"default","dismissible":true,
         "groups":[
          {"provider":"kimi","label":"Kimi","models":[
            {"name":"K3","blurb":"Moonshot's flagship: 256K on Moderato, up to 1M on Allegretto+, with always-on Low, High, or Max thinking."},
            {"name":"K2.7 Coding Highspeed","blurb":"The same K2.7 Coding intelligence at roughly 5–6× output speed — enable Fast mode. Thinking is always on."}
          ]},
          {"provider":"ollama","label":"Ollama","models":[
            {"name":"Deep Reinforce - Ornith 9B + Ornith 35B","blurb":"Open-source models for agentic coding.","accentProvider":"deep-reinforce"},
            {"name":"Liquid - LFM 2.5 8B-A1B","blurb":"Local tool/thinking model.","accentProvider":"liquid"},
            {"name":"Poolside - Laguna XS 2.1 33B-A3B Q8","blurb":"Local coding model with tool use and thinking.","accentProvider":"poolside"}
          ]}
         ]}
        """
        let notice = try JSONDecoder().decode(FirstLaunchNotice.self, from: Data(json.utf8))

        #expect(notice.groups?.count == 2)
        #expect(notice.groups?.first?.provider == "kimi")
        #expect(notice.groups?.first?.label == "Kimi")
        #expect(notice.groups?.first?.models.map(\.name) == ["K3", "K2.7 Coding Highspeed"])
        #expect(notice.groups?.first?.models.first?.blurb.contains("256K") == true)
        #expect(notice.groups?.first?.models.first?.blurb.contains("up to 1M") == true)
        #expect(notice.groups?.first?.models.last?.blurb.contains("5–6×") == true)
        #expect(notice.groups?.contains { $0.provider == "claude" } == false)
        #expect(notice.groups?.last?.provider == "ollama")
        #expect(notice.groups?.last?.models.first?.name == "Deep Reinforce - Ornith 9B + Ornith 35B")
        #expect(notice.groups?.last?.models.map(\.accentProvider) == ["deep-reinforce", "liquid", "poolside"])
        #expect(notice.groups?.last?.models.last?.name == "Poolside - Laguna XS 2.1 33B-A3B Q8")
    }

    @Test("a notice without groups decodes groups as nil")
    func decodesNilGroupsWhenAbsent() throws {
        let json = """
        {"id":"plain","kind":"info","title":"Plain notice","body":"No groups here.","tone":"default","dismissible":true}
        """
        let notice = try JSONDecoder().decode(FirstLaunchNotice.self, from: Data(json.utf8))
        #expect(notice.groups == nil)
    }
}
