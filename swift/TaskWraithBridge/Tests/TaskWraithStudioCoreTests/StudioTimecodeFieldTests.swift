import XCTest

@testable import TaskWraithStudioCore

/// Typed-into timecode entry, which is the half of mission outcome 2 that a
/// keyboard shortcut cannot provide.
final class StudioTimecodeFieldTests: XCTestCase {
    private let ntsc = StudioTimebase.ntsc2997

    private func typing(_ digits: String, dropFrame: Bool = false) -> StudioTimecodeField {
        var field = StudioTimecodeField(usesDropFrame: dropFrame)
        field.begin()
        for character in digits {
            field.input(character)
        }
        return field
    }

    // MARK: - Filling from the right

    /// The behaviour every deck and NLE trains: "412" is four seconds and twelve
    /// frames, not four hours. Getting this backwards makes the field actively
    /// dangerous, because the operator's muscle memory produces a wrong seek.
    func testDigitsFillFromTheRight() throws {
        let field = typing("412")
        let text = try XCTUnwrap(field.commitText())
        XCTAssertEqual(text, "00:00:04:12")
        XCTAssertEqual(
            try StudioTimecodeConverter.frameCount(forText: text, timebase: ntsc),
            4 * 30 + 12
        )
    }

    func testASingleDigitIsAFrameCount() throws {
        XCTAssertEqual(try XCTUnwrap(typing("7").commitText()), "00:00:00:07")
    }

    func testAFullEightDigitsFillEveryField() throws {
        XCTAssertEqual(try XCTUnwrap(typing("01023004").commitText()), "01:02:30:04")
    }

    /// Overflow shifts rather than jams: a field that silently ignores keys once
    /// it is full feels broken and hides the operator's real intent.
    func testATextTooLongShiftsTheOldestDigitOff() throws {
        XCTAssertEqual(try XCTUnwrap(typing("010230045").commitText()), "10:23:00:45")
    }

    func testNonDigitsAreRejectedSoTheKeyCanFallThrough() {
        var field = StudioTimecodeField()
        field.begin()
        XCTAssertTrue(field.input("4"))
        // Returning false is what lets the viewer treat "i" as mark-In rather
        // than swallowing every keystroke while entry is open.
        XCTAssertFalse(field.input("i"))
        XCTAssertFalse(field.input(":"))
        XCTAssertEqual(field.digits, "4")
    }

    func testInputIsIgnoredWhileInactive() {
        var field = StudioTimecodeField()
        XCTAssertFalse(field.input("4"))
        XCTAssertNil(field.snapshot)
        XCTAssertNil(field.commitText())
    }

    // MARK: - Editing

    func testBackspaceRemovesTheLastDigit() {
        var field = typing("412")
        XCTAssertTrue(field.backspace())
        XCTAssertEqual(field.digits, "41")
        XCTAssertTrue(field.backspace())
        XCTAssertTrue(field.backspace())
        XCTAssertFalse(field.backspace(), "backspace on an empty field is a no-op")
    }

    func testCancelDiscardsEverything() {
        var field = typing("412")
        field.cancel()
        XCTAssertFalse(field.isActive)
        XCTAssertNil(field.snapshot)
        XCTAssertNil(field.commitText())
    }

    func testAnEmptyFieldCommitsNothing() {
        var field = StudioTimecodeField()
        field.begin()
        XCTAssertNil(field.commitText(), "committing an untouched field must not seek")
    }

    // MARK: - Display

    /// The caret marks the slot that becomes occupied NEXT, and it travels LEFT
    /// as the run grows — because digits always enter at the right and shift
    /// everything along. Empty puts it in the frames-units slot (the first digit
    /// lands there); after one digit it sits one place left, which is where that
    /// digit is about to move to.
    ///
    /// My first pass at these expectations had the empty caret on the wrong side
    /// and omitted it entirely from the drop-frame case. The implementation was
    /// right both times; the expectations were mine and wrong, so they are
    /// corrected here rather than the assertion being loosened.
    func testDisplayShowsTypedDigitsRightAlignedWithACaret() {
        XCTAssertEqual(typing("").displayText, "--:--:--:-_")
        XCTAssertEqual(typing("4").displayText, "--:--:--:_4")
        XCTAssertEqual(typing("412").displayText, "--:--:_4:12")
        // Full: every slot is a digit, so there is nowhere for a caret to go.
        XCTAssertEqual(typing("01023004").displayText, "01:02:30:04")
    }

    func testSnapshotIsNilUntilEntryBegins() {
        var field = StudioTimecodeField()
        XCTAssertNil(field.snapshot)
        field.begin()
        XCTAssertEqual(field.snapshot?.displayText, "--:--:--:-_")
        XCTAssertEqual(field.snapshot?.digits, "")
    }

    // MARK: - Drop frame

    /// The separator is not decoration: it is what tells the parser to apply
    /// drop-frame arithmetic and drop-frame legality.
    func testDropFrameEmitsASemicolonSeparator() throws {
        let text = try XCTUnwrap(typing("10000", dropFrame: true).commitText())
        XCTAssertEqual(text, "00:01:00;00")
        XCTAssertEqual(typing("10000", dropFrame: true).displayText, "--:_1:00;00")
    }

    /// 00:01:00;00 is a label drop-frame never assigns. The field's job is to
    /// produce it faithfully so the CONVERTER can reject it — quietly rewriting
    /// it here would hide a typo behind a seek to the wrong frame.
    func testANonexistentDropFrameLabelReachesTheConverterAndIsRejected() throws {
        let text = try XCTUnwrap(typing("10000", dropFrame: true).commitText())
        XCTAssertThrowsError(
            try StudioTimecodeConverter.frameCount(forText: text, timebase: ntsc)
        ) { error in
            XCTAssertEqual(
                error as? StudioTimecodeError,
                .nonexistentDropFrameLabel("00:01:00;00")
            )
        }
    }

    func testAValidDropFrameEntryResolves() throws {
        let text = try XCTUnwrap(typing("10002", dropFrame: true).commitText())
        XCTAssertEqual(text, "00:01:00;02")
        XCTAssertEqual(
            try StudioTimecodeConverter.frameCount(forText: text, timebase: ntsc),
            1800
        )
    }

    /// A 29.97 asset can still be addressed in non-drop notation, so the
    /// separator follows the FIELD's setting rather than the timebase's
    /// capability.
    func testNonDropEntryAgainstADropCapableTimebaseStillResolves() throws {
        let text = try XCTUnwrap(typing("10000").commitText())
        XCTAssertEqual(text, "00:01:00:00")
        XCTAssertEqual(
            try StudioTimecodeConverter.frameCount(forText: text, timebase: ntsc),
            1800
        )
    }
}
