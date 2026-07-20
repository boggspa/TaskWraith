import Testing

@testable import TaskWraithUI

@Suite("MarkdownLite")
struct MarkdownLiteTests {
    @MainActor
    @Test func recoversTableAfterPipeProseLine() {
        let kinds = MarkdownLite._markdownLiteBlockKindsForTesting(
            [
                "Use provider | model notation here.",
                "| Participant | Shell | Gates |",
                "| --- | --- | --- |",
                "| Kimi | `*.test.ts` | line-budget |"
            ].joined(separator: "\n"))

        #expect(kinds == ["paragraph", "table"])
    }

    @MainActor
    @Test func keepsInvalidPipeLinesAsParagraph() {
        let kinds = MarkdownLite._markdownLiteBlockKindsForTesting(
            [
                "Use provider | model notation here.",
                "Kimi | ready"
            ].joined(separator: "\n"))

        #expect(kinds == ["paragraph"])
    }

    @MainActor
    @Test func capturesFencedCodeLanguageInfoString() {
        let kinds = MarkdownLite._markdownLiteBlockKindsForTesting(
            [
                "```swift",
                "let x = 1",
                "```"
            ].joined(separator: "\n"))

        #expect(kinds == ["code:swift"])
    }

    @MainActor
    @Test func fencedCodeWithoutLanguageIsPlainCode() {
        let kinds = MarkdownLite._markdownLiteBlockKindsForTesting(
            [
                "```",
                "echo hi",
                "```"
            ].joined(separator: "\n"))

        #expect(kinds == ["code"])
    }

    @MainActor
    @Test func formatEnsembleDmMentionEscapesAndPreservesId() {
        #expect(
            twFormatEnsembleDmMention(label: "Code Reviewer", participantId: "p-1")
                == "[@Code Reviewer](ensemble-dm://p-1)")
        #expect(
            twFormatEnsembleDmMention(label: "A]B", participantId: "p-2")
                == #"[@A\]B](ensemble-dm://p-2)"#)
        #expect(twFormatEnsembleDmMention(label: "x", participantId: "  ") == "")
    }
}
