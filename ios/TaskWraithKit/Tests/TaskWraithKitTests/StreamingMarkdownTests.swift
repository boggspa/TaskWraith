import Testing

@testable import TaskWraithKit

@Suite("StreamingMarkdownSplitter")
struct StreamingMarkdownSplitterTests {
    @Test func emptyTextSplitsEmpty() {
        let split = StreamingMarkdownSplitter.split("")
        #expect(split.settled == "")
        #expect(split.tail == "")
    }

    @Test func singleGrowingParagraphIsAllTail() {
        let split = StreamingMarkdownSplitter.split("Streaming **bold but unfin")
        #expect(split.settled == "")
        #expect(split.tail == "Streaming **bold but unfin")
    }

    @Test func completedParagraphSettles() {
        let split = StreamingMarkdownSplitter.split("First paragraph.\n\nSecond grow")
        #expect(split.settled == "First paragraph.\n\n")
        #expect(split.tail == "Second grow")
    }

    @Test func textEndingWithBlankLineIsFullySettled() {
        let split = StreamingMarkdownSplitter.split("Done paragraph.\n\n")
        #expect(split.settled == "Done paragraph.\n\n")
        #expect(split.tail == "")
    }

    @Test func blankLinesInsideOpenFenceDoNotSettle() {
        let text = "Intro.\n\n```swift\nlet a = 1\n\nlet b = 2\n"
        let split = StreamingMarkdownSplitter.split(text)
        // The fence is still open — the only safe boundary is before it.
        #expect(split.settled == "Intro.\n\n")
        #expect(split.tail == "```swift\nlet a = 1\n\nlet b = 2\n")
    }

    @Test func closedFenceSettlesAfterFollowingBlankLine() {
        let text = "Intro.\n\n```\ncode\n```\n\nOutro grow"
        let split = StreamingMarkdownSplitter.split(text)
        #expect(split.settled == "Intro.\n\n```\ncode\n```\n\n")
        #expect(split.tail == "Outro grow")
    }

    @Test func listsStayInTailUntilBlankLine() {
        let text = "Plan:\n\n- one\n- two\n- thr"
        let split = StreamingMarkdownSplitter.split(text)
        #expect(split.settled == "Plan:\n\n")
        #expect(split.tail == "- one\n- two\n- thr")
    }

    @Test func incrementalSplitExtendsTailWithoutRescanningSettled() {
        let first = "First paragraph.\n\nSecond grow"
        let firstSplit = StreamingMarkdownSplitter.split(first)
        let second = first + "ing token"
        let incremental = StreamingMarkdownSplitter.splitIncremental(
            previousSettled: firstSplit.settled,
            previousText: first,
            text: second)
        #expect(incremental.settled == firstSplit.settled)
        #expect(incremental.tail == "Second growing token")
        #expect(incremental == StreamingMarkdownSplitter.split(second))
    }

    @Test func incrementalSplitResplitsWhenParagraphBoundaryCrosses() {
        let growing = "Done paragraph."
        let beforeBoundary = StreamingMarkdownSplitter.splitIncremental(
            previousSettled: "",
            previousText: "",
            text: growing)
        #expect(beforeBoundary == ("", growing))

        let afterBoundary = growing + "\n\nNext"
        let incremental = StreamingMarkdownSplitter.splitIncremental(
            previousSettled: beforeBoundary.settled,
            previousText: growing,
            text: afterBoundary)
        #expect(incremental == StreamingMarkdownSplitter.split(afterBoundary))
    }

    @Test func incrementalSplitRewindsOnNonPrefixUpdate() {
        let previous = "First paragraph.\n\nTail"
        let split = StreamingMarkdownSplitter.split(previous)
        let replaced = "Different text"
        let incremental = StreamingMarkdownSplitter.splitIncremental(
            previousSettled: split.settled,
            previousText: previous,
            text: replaced)
        #expect(incremental == StreamingMarkdownSplitter.split(replaced))
    }

    @Test func incrementalSplitResplitsWhenWhitespaceOnlyLineCrossesChunkBoundary() {
        let previousText = "Done paragraph.\n"
        let growth = "   \nNext grow"
        #expect(
            StreamingMarkdownSplitter.growthContainsNewSettlingBoundary(
                since: previousText, growth: growth))
        let incremental = StreamingMarkdownSplitter.splitIncremental(
            previousSettled: "",
            previousText: previousText,
            text: previousText + growth)
        #expect(incremental == StreamingMarkdownSplitter.split(previousText + growth))
    }

    @Test func incrementalSplitResplitsAfterFenceCloseThenBlankLine() {
        let chunk1 = "Intro.\n\n```\ncode"
        let split1 = StreamingMarkdownSplitter.splitIncremental(
            previousSettled: "", previousText: "", text: chunk1)
        #expect(split1 == StreamingMarkdownSplitter.split(chunk1))

        let chunk2 = chunk1 + "\n```"
        let split2 = StreamingMarkdownSplitter.splitIncremental(
            previousSettled: split1.settled,
            previousText: chunk1,
            text: chunk2)
        #expect(split2 == StreamingMarkdownSplitter.split(chunk2))

        let chunk3 = chunk2 + "\n\nNext grow"
        let split3 = StreamingMarkdownSplitter.splitIncremental(
            previousSettled: split2.settled,
            previousText: chunk2,
            text: chunk3)
        #expect(split3 == StreamingMarkdownSplitter.split(chunk3))
        #expect(split3.settled == "Intro.\n\n```\ncode\n```\n\n")
        #expect(split3.tail == "Next grow")
    }
}

@Suite("StreamingInterleave")
struct StreamingInterleaveTests {
    typealias E = StreamingInterleave.Element

    @Test func noToolsIsJustTheTail() {
        let plan = StreamingInterleave.plan(segments: ["hello"], toolCounts: [])
        #expect(plan == [.text(segmentIndex: 0, isTail: true)])
    }

    @Test func textToolTextInterleaves() {
        let plan = StreamingInterleave.plan(segments: ["before", "after"], toolCounts: [1])
        #expect(
            plan == [
                .text(segmentIndex: 0, isTail: false),
                .toolRow(index: 0),
                .text(segmentIndex: 1, isTail: true)
            ])
    }

    @Test func groupedRowConsumesItsEmptySegments() {
        // Mac collapsed 3 back-to-back calls into one row; the stream sealed
        // empty segments between them.
        let plan = StreamingInterleave.plan(
            segments: ["intro", "", "", "outro"], toolCounts: [3])
        #expect(
            plan == [
                .text(segmentIndex: 0, isTail: false),
                .toolRow(index: 0),
                .text(segmentIndex: 3, isTail: true)
            ])
    }

    @Test func separateRowsWithEmptyBetween() {
        let plan = StreamingInterleave.plan(segments: ["a", "", "c"], toolCounts: [1, 1])
        #expect(
            plan == [
                .text(segmentIndex: 0, isTail: false),
                .toolRow(index: 0),
                .toolRow(index: 1),
                .text(segmentIndex: 2, isTail: true)
            ])
    }

    @Test func snapshotLagFlushesTrailingSegments() {
        // Stream is two tools ahead of the (debounced) snapshot.
        let plan = StreamingInterleave.plan(segments: ["a", "b", "c"], toolCounts: [1])
        #expect(
            plan == [
                .text(segmentIndex: 0, isTail: false),
                .toolRow(index: 0),
                .text(segmentIndex: 1, isTail: false),
                .text(segmentIndex: 2, isTail: true)
            ])
    }

    @Test func groupedTextSurvivesDefensiveSkip() {
        // The Mac says one row covers 2 calls but the stream put REAL text
        // between them — never drop it.
        let plan = StreamingInterleave.plan(segments: ["a", "mid", "c"], toolCounts: [2])
        #expect(
            plan == [
                .text(segmentIndex: 0, isTail: false),
                .toolRow(index: 0),
                .text(segmentIndex: 1, isTail: false),
                .text(segmentIndex: 2, isTail: true)
            ])
    }

    @Test func moreClaimedToolsThanBoundariesFallsBackToLegacyOrder() {
        // Attached mid-run (or a provider without tool markers): rows first,
        // then the live text — exactly the pre-segmentation behavior.
        let plan = StreamingInterleave.plan(segments: ["tail only"], toolCounts: [1, 2])
        #expect(
            plan == [
                .toolRow(index: 0),
                .toolRow(index: 1),
                .text(segmentIndex: 0, isTail: true)
            ])
    }

    @Test func emptyTailAfterFreshBoundaryRendersNothingExtra() {
        // Tool just sealed the segment; no text has streamed since.
        let plan = StreamingInterleave.plan(segments: ["before", ""], toolCounts: [1])
        #expect(
            plan == [
                .text(segmentIndex: 0, isTail: false),
                .toolRow(index: 0)
            ])
    }
}

@Suite("StreamingSnapshotFold")
struct StreamingSnapshotFoldTests {
    typealias D = StreamingSnapshotFold.Decision

    @Test func firstChunkOnEmptyTailAppends() {
        #expect(StreamingSnapshotFold.plan(segments: [""], incoming: "Hello") == .append)
    }

    @Test func genuineIncrementAppends() {
        // Codex/Gemini/Kimi: the delta is the NEW suffix, never the full prose.
        #expect(StreamingSnapshotFold.plan(segments: ["Hello"], incoming: " world") == .append)
    }

    @Test func cumulativeSnapshotNoToolReplacesTheGrowingSegment() {
        // Cursor pre-tool: each frame re-states the whole turn. With a single
        // segment the tail IS the full snapshot — replace, don't append (which
        // would yield "Reading.Reading. more").
        #expect(
            StreamingSnapshotFold.plan(segments: ["Reading."], incoming: "Reading. more")
                == .replaceLastSegment("Reading. more"))
    }

    @Test func cumulativeSnapshotAcrossAToolKeepsOnlyTheTail() {
        // The crux: text "Reading." → tool sealed → Cursor re-emits the WHOLE
        // turn untagged. Only the post-tool tail belongs in the new segment;
        // the pre-tool "Reading." stays in the earlier sealed segment. A blind
        // append would duplicate "Reading." below the tool.
        #expect(
            StreamingSnapshotFold.plan(
                segments: ["Reading.", ""], incoming: "Reading.\n\nEditing.")
                == .replaceLastSegment("\n\nEditing."))
    }

    @Test func cumulativeSnapshotAcrossTwoToolsKeepsOnlyTheNewestTail() {
        // text → tool → "Editing." → tool → Cursor restates the full turn.
        // Earlier segments hold "Reading." + "\n\nEditing."; only "\n\nDone."
        // lands in the latest segment.
        #expect(
            StreamingSnapshotFold.plan(
                segments: ["Reading.", "\n\nEditing.", ""],
                incoming: "Reading.\n\nEditing.\n\nDone.")
                == .replaceLastSegment("\n\nDone."))
    }

    @Test func staleShorterSnapshotIsSkipped() {
        // An out-of-order/older Cursor frame shorter than what we already show.
        #expect(
            StreamingSnapshotFold.plan(segments: ["Reading. more"], incoming: "Reading.") == .skip)
    }

    @Test func equalRestatementReplacesToANoOpTail() {
        // Re-statement equal to the accumulated text after a tool: tail empty,
        // last segment stays empty — no duplication, nothing extra rendered.
        #expect(
            StreamingSnapshotFold.plan(segments: ["Reading.", ""], incoming: "Reading.")
                == .replaceLastSegment(""))
    }

    @Test func divergentDeltaThatIsNotASupersetAppends() {
        // A delta that neither supersets nor is a prefix of the shown text is a
        // genuine increment (e.g. provider whitespace quirk) — append, never drop.
        #expect(
            StreamingSnapshotFold.plan(segments: ["Hello"], incoming: "Goodbye") == .append)
    }

    // End-to-end: the full Cursor live interleave. Drive the snapshot-fold the
    // way RemoteSessionModel.appendStreamingDeltas does, then plan the
    // interleave — the result must be text → tool → text → tool with NO
    // duplicated pre-tool prose.
    @Test func cursorSnapshotStreamInterleavesWithoutDuplication() {
        var segments = [""]
        func content(_ snapshot: String) {
            switch StreamingSnapshotFold.plan(segments: segments, incoming: snapshot) {
            case .append: segments[segments.count - 1] += snapshot
            case .replaceLastSegment(let tail): segments[segments.count - 1] = tail
            case .skip: break
            }
        }
        func toolBoundary() { segments.append("") }

        content("Reading the file.")            // frame 1 (full snapshot)
        toolBoundary()                          // read_file
        content("Reading the file.\n\nNow editing.")   // frame 2 (full snapshot)
        toolBoundary()                          // edit_file
        content("Reading the file.\n\nNow editing.\n\nDone.")  // frame 3 (full snapshot)

        #expect(segments == ["Reading the file.", "\n\nNow editing.", "\n\nDone."])

        // Two separate (non-collapsed) tool rows, each covering one call.
        let plan = StreamingInterleave.plan(segments: segments, toolCounts: [1, 1])
        #expect(
            plan == [
                .text(segmentIndex: 0, isTail: false),
                .toolRow(index: 0),
                .text(segmentIndex: 1, isTail: false),
                .toolRow(index: 1),
                .text(segmentIndex: 2, isTail: true)
            ])
        // The pre-tool prose appears exactly once, in segment 0.
        #expect(segments.filter { $0.contains("Reading the file.") }.count == 1)
    }

    // Cursor snapshot stream with BACK-TO-BACK tools the Mac collapses into one
    // row: the snapshot fold leaves an empty middle segment that the interleave
    // consumes under the grouped row, and the post-burst tail lands after it.
    @Test func cursorSnapshotWithCollapsedBackToBackToolsGroupsCorrectly() {
        var segments = [""]
        func content(_ snapshot: String) {
            switch StreamingSnapshotFold.plan(segments: segments, incoming: snapshot) {
            case .append: segments[segments.count - 1] += snapshot
            case .replaceLastSegment(let tail): segments[segments.count - 1] = tail
            case .skip: break
            }
        }
        content("Searching.")          // snapshot
        segments.append("")            // tool 1 (grep)
        segments.append("")            // tool 2 (grep) — back-to-back, no text
        content("Searching.\n\nFound it.")  // snapshot restating the whole turn

        #expect(segments == ["Searching.", "", "\n\nFound it."])

        // The Mac collapsed the two grep calls into ONE row covering 2 calls.
        let plan = StreamingInterleave.plan(segments: segments, toolCounts: [2])
        #expect(
            plan == [
                .text(segmentIndex: 0, isTail: false),
                .toolRow(index: 0),
                .text(segmentIndex: 2, isTail: true)
            ])
    }
}

@Suite("StreamingDeltaRouting")
struct StreamingDeltaRoutingTests {
    @Test func taggedSnapshotRestatementAlwaysFolds() {
        // Cursor runItemCumulative/snapshot frames reconcile via the fold
        // regardless of provenance.
        #expect(
            StreamingDeltaRouting.decide(
                taggedSnapshotRestatement: true, trustedCompatLine: true) == .fold)
        #expect(
            StreamingDeltaRouting.decide(
                taggedSnapshotRestatement: true, trustedCompatLine: false) == .fold)
    }

    @Test func untaggedTrustedCompatLineAppendsVerbatim() {
        // Desktop trustedIncremental parity: an untagged delta from the
        // audited compat chokepoint is a verbatim increment — a repeated
        // chunk that byte-matches the bubble must not be fold-swallowed.
        #expect(
            StreamingDeltaRouting.decide(
                taggedSnapshotRestatement: false, trustedCompatLine: true) == .appendVerbatim)
    }

    @Test func untaggedUntrustedLineKeepsShapeDetection() {
        // Legacy raw-stdout lines carry no tags — the fold stays.
        #expect(
            StreamingDeltaRouting.decide(
                taggedSnapshotRestatement: false, trustedCompatLine: false) == .fold)
    }

    @Test func assistantDeltaSidecarEstablishesProvenance() {
        let line: [String: Any] = [
            "runItemEvents": [
                ["kind": "item/delta", "channel": "assistant", "delta": "Hello"]
            ]
        ]
        #expect(StreamingDeltaRouting.hasAssistantDeltaSidecar(line["runItemEvents"]))
    }

    @Test func nonAssistantOrEmptySidecarsDoNotEstablishProvenance() {
        // Missing entirely (legacy raw line).
        #expect(!StreamingDeltaRouting.hasAssistantDeltaSidecar(nil))
        // Tool sidecar only — the line's text was not projected.
        #expect(
            !StreamingDeltaRouting.hasAssistantDeltaSidecar([
                ["kind": "tool/progress", "toolName": "read_file"]
            ]))
        // Empty assistant delta cannot vouch for the legacy text.
        #expect(
            !StreamingDeltaRouting.hasAssistantDeltaSidecar([
                ["kind": "item/delta", "channel": "assistant", "delta": ""]
            ]))
        // Non-assistant channel.
        #expect(
            !StreamingDeltaRouting.hasAssistantDeltaSidecar([
                ["kind": "item/delta", "channel": "stdout", "delta": "x"]
            ]))
    }
}
