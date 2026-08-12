import XCTest

@testable import TaskWraithStudioCore

/// Timecode arithmetic, asserted against known SMPTE landmarks rather than
/// against the implementation's own reasoning.
final class StudioTimecodeTests: XCTestCase {
    private let ntsc = StudioTimebase.ntsc2997
    private let pal = StudioTimebase.pal25
    private let film = StudioTimebase.ntsc23976

    // MARK: - Rates

    func testNominalRateIsTheRoundedRealRate() {
        XCTAssertEqual(StudioTimecodeConverter.nominalRate(for: ntsc), 30)
        XCTAssertEqual(StudioTimecodeConverter.nominalRate(for: film), 24)
        XCTAssertEqual(StudioTimecodeConverter.nominalRate(for: pal), 25)
        XCTAssertEqual(StudioTimecodeConverter.nominalRate(for: .fps60), 60)
    }

    /// Drop-frame exists to reconcile 1001-denominator rates with wall clock. It
    /// is meaningless at 25 or 24 and must not be silently accepted there.
    func testDropFrameIsOnlyDefinedFor1001Rates() {
        XCTAssertTrue(StudioTimecodeConverter.supportsDropFrame(ntsc))
        XCTAssertFalse(StudioTimecodeConverter.supportsDropFrame(pal))
        XCTAssertFalse(
            StudioTimecodeConverter.supportsDropFrame(film),
            "23.976 has no standard drop-frame form"
        )

        XCTAssertThrowsError(
            try StudioTimecodeConverter.timecode(forFrame: 0, timebase: pal, dropFrame: true)
        ) { error in
            XCTAssertEqual(
                error as? StudioTimecodeError,
                .dropFrameUnsupportedForRate(nominalRate: 25)
            )
        }
    }

    // MARK: - Non-drop

    func testNonDropLandmarks() throws {
        func label(_ frame: Int64) throws -> String {
            try StudioTimecodeConverter.timecode(forFrame: frame, timebase: ntsc).text
        }
        XCTAssertEqual(try label(0), "00:00:00:00")
        XCTAssertEqual(try label(29), "00:00:00:29")
        XCTAssertEqual(try label(30), "00:00:01:00")
        XCTAssertEqual(try label(1800), "00:01:00:00")
        XCTAssertEqual(try label(108_000), "01:00:00:00")
    }

    func testPalAndFilmLandmarks() throws {
        XCTAssertEqual(
            try StudioTimecodeConverter.timecode(forFrame: 25, timebase: pal).text,
            "00:00:01:00"
        )
        XCTAssertEqual(
            try StudioTimecodeConverter.timecode(forFrame: 24, timebase: film).text,
            "00:00:01:00"
        )
    }

    // MARK: - Drop-frame

    /// The exact frames where drop-frame does and does not skip labels.
    func testDropFrameLandmarks() throws {
        func label(_ frame: Int64) throws -> String {
            try StudioTimecodeConverter.timecode(forFrame: frame, timebase: ntsc, dropFrame: true)
                .text
        }
        XCTAssertEqual(try label(0), "00:00:00;00")
        // Minute 0 drops nothing, so it runs the full 1800 labels.
        XCTAssertEqual(try label(1799), "00:00:59;29")
        // Minute 1 skips ;00 and ;01.
        XCTAssertEqual(try label(1800), "00:01:00;02")
        XCTAssertEqual(try label(1801), "00:01:00;03")
        // Minute 10 is exempt from the skip.
        XCTAssertEqual(try label(17982), "00:10:00;00")
        XCTAssertEqual(try label(107_892), "01:00:00;00")
    }

    /// WHY DROP-FRAME EXISTS, asserted rather than described. At exactly one hour
    /// of real time the drop-frame label reads 01:00:00;00 while the non-drop
    /// label reads 00:59:56:12 — the ~3.6s/hour error drop-frame absorbs.
    func testDropFrameTracksWallClockWhereNonDropDrifts() throws {
        let oneHourOfFrames: Int64 = 107_892
        let elapsedSeconds =
            Double(oneHourOfFrames) * Double(ntsc.frameDurationTicks) / Double(ntsc.timescale)
        XCTAssertEqual(elapsedSeconds, 3600.0, accuracy: 0.01, "this really is one hour")

        XCTAssertEqual(
            try StudioTimecodeConverter.timecode(
                forFrame: oneHourOfFrames,
                timebase: ntsc,
                dropFrame: true
            ).text,
            "01:00:00;00"
        )
        XCTAssertEqual(
            try StudioTimecodeConverter.timecode(forFrame: oneHourOfFrames, timebase: ntsc).text,
            "00:59:56:12",
            "non-drop labelling drifts ~3.6s per hour, which is the whole problem"
        )
    }

    /// A label drop-frame never assigns must be an error, not a value quietly
    /// rounded to a neighbouring frame.
    func testNonexistentDropFrameLabelsAreRejected() throws {
        for text in ["00:01:00;00", "00:01:00;01", "00:09:00;01"] {
            XCTAssertThrowsError(
                try StudioTimecodeConverter.frameCount(forText: text, timebase: ntsc),
                "\(text) does not exist in drop-frame"
            ) { error in
                XCTAssertEqual(error as? StudioTimecodeError, .nonexistentDropFrameLabel(text))
            }
        }
        // Minute 10 does not drop, so this one is legal.
        XCTAssertEqual(
            try StudioTimecodeConverter.frameCount(forText: "00:10:00;00", timebase: ntsc),
            17982
        )
    }

    func testDropFrameRoundTripsAcrossMinuteAndTenMinuteBoundaries() throws {
        for frame in stride(from: Int64(0), to: Int64(20_000), by: 199) {
            let timecode = try StudioTimecodeConverter.timecode(
                forFrame: frame,
                timebase: ntsc,
                dropFrame: true
            )
            XCTAssertEqual(
                try StudioTimecodeConverter.frameCount(for: timecode, timebase: ntsc),
                frame,
                "round trip failed at frame \(frame) (\(timecode.text))"
            )
        }
    }

    func testNonDropRoundTrips() throws {
        for frame in stride(from: Int64(0), to: Int64(10_000), by: 97) {
            let timecode = try StudioTimecodeConverter.timecode(forFrame: frame, timebase: ntsc)
            XCTAssertEqual(
                try StudioTimecodeConverter.frameCount(for: timecode, timebase: ntsc),
                frame
            )
        }
    }

    // MARK: - Parsing

    func testParsesFullTimecodeAndDetectsDropFrameFromTheSeparator() throws {
        let plain = try StudioTimecodeConverter.parse("01:02:03:04", timebase: ntsc)
        XCTAssertEqual(plain.hours, 1)
        XCTAssertEqual(plain.minutes, 2)
        XCTAssertEqual(plain.seconds, 3)
        XCTAssertEqual(plain.frames, 4)
        XCTAssertFalse(plain.isDropFrame)

        let drop = try StudioTimecodeConverter.parse("00:01:00;02", timebase: ntsc)
        XCTAssertTrue(drop.isDropFrame, "the semicolon is the drop-frame marker")
        XCTAssertEqual(try StudioTimecodeConverter.frameCount(for: drop, timebase: ntsc), 1800)
    }

    /// Timecode fields fill from the right, which is how every NLE entry box
    /// behaves: typing 12 means 12 frames, not 12 hours.
    func testBareDigitsFillFromTheRight() throws {
        XCTAssertEqual(try StudioTimecodeConverter.parse("12", timebase: ntsc).text, "00:00:00:12")
        XCTAssertEqual(try StudioTimecodeConverter.parse("1200", timebase: ntsc).text, "00:00:12:00")
        XCTAssertEqual(
            try StudioTimecodeConverter.parse("1000000", timebase: ntsc).text,
            "01:00:00:00"
        )
        XCTAssertEqual(
            try StudioTimecodeConverter.frameCount(forText: "100", timebase: ntsc),
            30,
            "00:00:01:00 is one second, i.e. 30 frames at nominal 30"
        )
    }

    func testMalformedAndOutOfRangeEntriesAreRejected() {
        for text in ["", "  ", "aa:bb:cc:dd", "1:2:3", "01:02:03:04:05", "123456789"] {
            XCTAssertThrowsError(
                try StudioTimecodeConverter.parse(text, timebase: ntsc),
                "\(text) should not parse"
            )
        }
        // 30 frames does not exist at nominal 30 (labels are 00...29).
        XCTAssertThrowsError(
            try StudioTimecodeConverter.parse("00:00:00:30", timebase: ntsc)
        ) { error in
            XCTAssertEqual(error as? StudioTimecodeError, .componentOutOfRange("00:00:00:30"))
        }
        XCTAssertThrowsError(try StudioTimecodeConverter.parse("00:60:00:00", timebase: ntsc))
    }

    func testNegativeFramesAreRejected() {
        XCTAssertThrowsError(
            try StudioTimecodeConverter.timecode(forFrame: -1, timebase: ntsc)
        ) { error in
            XCTAssertEqual(error as? StudioTimecodeError, .negativeFrame)
        }
    }
}
