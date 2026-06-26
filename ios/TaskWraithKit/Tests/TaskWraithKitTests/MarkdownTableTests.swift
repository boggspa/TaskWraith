import Testing

@testable import TaskWraithKit

@Suite("MarkdownTable")
struct MarkdownTableTests {
    @Test func parsesLeadingPipeTable() {
        let table = MarkdownTable.parse(lines: [
            "| Participant | Shell | Gates |",
            "| --- | --- | --- |",
            "| Kimi | `*.test.ts` | line-budget |"
        ])

        #expect(table?.headers == ["Participant", "Shell", "Gates"])
        #expect(table?.rows == [["Kimi", "`*.test.ts`", "line-budget"]])
        #expect(table?.alignments == [.leading, .leading, .leading])
    }

    @Test func parsesNoLeadingPipeTable() {
        let table = MarkdownTable.parse(lines: [
            "Name | Status",
            "--- | ---",
            "Kimi | ready"
        ])

        #expect(table?.headers == ["Name", "Status"])
        #expect(table?.rows == [["Kimi", "ready"]])
    }

    @Test func parsesAlignmentMarkers() {
        let table = MarkdownTable.parse(lines: [
            "| Left | Center | Right |",
            "| :--- | :---: | ---: |",
            "| a | b | c |"
        ])

        #expect(table?.alignments == [.leading, .center, .trailing])
    }

    @Test func preservesEmptyCellsAndPadsRaggedRows() {
        let table = MarkdownTable.parse(lines: [
            "| A | B | C |",
            "| --- | --- | --- |",
            "| left | | right |",
            "| short | row |"
        ])

        #expect(table?.rows.first == ["left", "", "right"])
        #expect(table?.rows.last == ["short", "row", ""])
    }

    @Test func keepsEscapedAndCodeSpanPipesInsideCells() {
        let table = MarkdownTable.parse(lines: [
            "| Expr | Value |",
            "| --- | --- |",
            "| a \\| b | `x|y` |"
        ])

        #expect(table?.rows == [["a | b", "`x|y`"]])
    }

    @Test func preservesBackslashesThatDoNotEscapePipes() {
        let table = MarkdownTable.parse(lines: [
            "| Path | Status |",
            "| --- | --- |",
            #"| C:\tmp\file.txt | present |"#
        ])

        #expect(table?.rows == [[#"C:\tmp\file.txt"#, "present"]])
    }

    @Test func requiresSeparatorRow() {
        #expect(MarkdownTable.parse(lines: ["| grep foo"]) == nil)
        #expect(MarkdownTable.parse(lines: ["Name | Status", "Kimi | ready"]) == nil)
    }

    @Test func rejectsInvalidSeparatorCells() {
        let table = MarkdownTable.parse(lines: [
            "| Name | Status |",
            "| --- | nope |",
            "| Kimi | ready |"
        ])

        #expect(table == nil)
    }
}
