import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Completion push content (decrypted blob)")
struct CompletionPushContentTests {
    @Test("decodes the Mac's run-complete JSON contract")
    func decodes() {
        let json = Data(
            "{\"title\":\"Codex\",\"preview\":\"Refactored the card\",\"filesChanged\":3,\"additions\":12,\"deletions\":4}"
                .utf8)
        #expect(
            CompletionPushContent.decode(json)
                == CompletionPushContent(
                    title: "Codex", preview: "Refactored the card", filesChanged: 3, additions: 12,
                    deletions: 4))
    }

    @Test("returns nil on malformed / missing-field JSON")
    func rejectsMalformed() {
        #expect(CompletionPushContent.decode(Data("not json".utf8)) == nil)
        #expect(CompletionPushContent.decode(Data("{\"title\":\"x\"}".utf8)) == nil)
    }

    @Test("bannerInput threads the failed flag through to the renderer input")
    func bannerInput() {
        let c = CompletionPushContent(
            title: "Claude", preview: "broke", filesChanged: 0, additions: 0, deletions: 0)
        #expect(c.bannerInput(failed: true).failed == true)
        #expect(c.bannerInput(failed: false).title == "Claude")
    }

    @Test("question push content renders the first line with question emoji")
    func questionPushContent() {
        let json = Data("{\"question\":\"Ship this now?\\nMore context\"}".utf8)
        let content = QuestionPushContent.decode(json)
        #expect(content == QuestionPushContent(question: "Ship this now?\nMore context"))
        #expect(content?.bannerBody == "\u{2753} Ship this now?")
    }
}
