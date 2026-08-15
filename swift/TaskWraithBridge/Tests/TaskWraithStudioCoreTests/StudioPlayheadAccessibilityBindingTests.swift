import XCTest

@testable import TaskWraithStudioCore

/// RED-FIRST control for the VoiceOver playhead.
///
/// An AX value-set must move the existing `StudioTransportController`. Reverting
/// the binding must refuse and leave the playhead where it was. That pair is
/// what makes this an accessibility feature rather than an unbound test hook.
final class StudioPlayheadAccessibilityBindingTests: XCTestCase {
    /// 30 fps integer timebase so ticks and frames read identically.
    private func makeController(durationTicks: Int64 = 600) -> StudioTransportController {
        StudioTransportController(
            clock: StudioPlaybackClock(
                timebase: StudioTimebase(timescale: 30, frameDurationTicks: 1)!,
                durationTicks: durationTicks
            )
        )
    }

    func testSettingTicksSeeksTheOneTransport() {
        var transport = makeController()
        let binding = StudioPlayheadAccessibilityBinding(isBound: true)

        XCTAssertTrue(binding.apply(.ticks(180), to: &transport, atHost: 0))
        XCTAssertEqual(
            transport.clock.snapshot(atHost: 0).positionTicks,
            180,
            "an assistive value-set must seek the existing transport"
        )
    }

    func testTimecodeTextSeeksTheSameTransport() {
        var transport = makeController()
        let binding = StudioPlayheadAccessibilityBinding()

        XCTAssertTrue(binding.apply(.timecode("00:00:06:00"), to: &transport, atHost: 0))
        XCTAssertEqual(
            transport.clock.snapshot(atHost: 0).frameIndex,
            180,
            "6 seconds at 30 fps is frame 180 on the same clock"
        )
    }

    func testRevertingTheBindingRefusesAndLeavesThePlayhead() {
        var transport = makeController()
        transport.seek(toTicks: 90, atHost: 0)
        let binding = StudioPlayheadAccessibilityBinding(isBound: false)

        XCTAssertFalse(
            binding.apply(.ticks(400), to: &transport, atHost: 0),
            "reverting the binding is the control: a value-set must become a no-op"
        )
        XCTAssertEqual(
            transport.clock.snapshot(atHost: 0).positionTicks,
            90,
            "an unbound slider must not grow a second playhead"
        )
        XCTAssertFalse(binding.step(frames: 1, to: &transport, atHost: 0))
        XCTAssertEqual(transport.clock.snapshot(atHost: 0).positionTicks, 90)
    }

    func testInvalidTimecodeDoesNotMoveTheTransport() {
        var transport = makeController()
        transport.seek(toTicks: 40, atHost: 0)
        let binding = StudioPlayheadAccessibilityBinding()

        XCTAssertFalse(binding.apply(.timecode("not-a-timecode"), to: &transport, atHost: 0))
        XCTAssertEqual(transport.clock.snapshot(atHost: 0).positionTicks, 40)
    }

    func testStepUsesTheSameTransport() {
        var transport = makeController()
        let binding = StudioPlayheadAccessibilityBinding()

        XCTAssertTrue(binding.step(frames: 3, to: &transport, atHost: 0))
        XCTAssertEqual(transport.clock.snapshot(atHost: 0).frameIndex, 3)
        XCTAssertTrue(binding.step(frames: -1, to: &transport, atHost: 0))
        XCTAssertEqual(transport.clock.snapshot(atHost: 0).frameIndex, 2)
    }

    func testParseAcceptsNumbersAndSpokenText() {
        XCTAssertEqual(StudioPlayheadAccessibilityValue.parse(NSNumber(value: 250)), .ticks(250))
        XCTAssertEqual(StudioPlayheadAccessibilityValue.parse("120"), .ticks(120))
        XCTAssertEqual(
            StudioPlayheadAccessibilityValue.parse("00:00:04:00"),
            .timecode("00:00:04:00")
        )
        XCTAssertNil(StudioPlayheadAccessibilityValue.parse(""))
        XCTAssertNil(StudioPlayheadAccessibilityValue.parse(nil as Any?))
    }
}
