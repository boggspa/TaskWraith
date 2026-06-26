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
}
