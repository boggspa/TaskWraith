import AppKit
import XCTest

@testable import TaskWraithStudioCompanion
@testable import TaskWraithStudioCore

@MainActor
final class StudioViewerDeckChromeTests: XCTestCase {
  private func makeWorkspace() throws -> StudioWorkspaceWindowController {
    guard let device = MTLCreateSystemDefaultDevice() else {
      throw XCTSkip("no Metal device")
    }
    let timebase = try XCTUnwrap(
      StudioTimebase(timescale: 600, frameDurationTicks: 20)
    )
    return StudioWorkspaceWindowController(
      sourceRenderer: try StudioViewerRenderer(device: device),
      reviewRenderer: try StudioViewerRenderer(device: device),
      authority: StudioPlaybackAuthority(
        clock: StudioPlaybackClock(timebase: timebase, durationTicks: 6_000)
      )
    )
  }

  private func makeReviewTimeline() -> StudioProposedTimeline {
    let timebase = StudioTimebase(timescale: 600, frameDurationTicks: 20)!
    let op = StudioInsertRangeOp(
      itemId: "insert-chrome",
      assetId: "asset-inserted",
      trackId: nil,
      sourceIn: StudioRationalTime(n: 0, d: 600)!,
      sourceOut: StudioRationalTime(n: 600, d: 600)!,
      at: StudioRationalTime(n: 1_200, d: 600)!
    )
    return StudioProposedTimeline(
      proposal: StudioEditProposal(
        proposalId: "proposal-chrome",
        createdRevision: 1,
        op: op
      ),
      timebase: timebase
    )!
  }

  func testChromeHasTheLockedAccessibilityContract() throws {
    let workspace = try makeWorkspace()
    let chrome = workspace.viewerDeckChrome

    XCTAssertEqual(chrome.identifier?.rawValue, "studio.workspace.viewer-deck.chrome")
    XCTAssertEqual(chrome.accessibilityRole(), .group)

    let expected: [(String, String)] = [
      ("studio.workspace.route.source", "Source"),
      ("studio.workspace.route.timeline", "Timeline"),
      ("studio.workspace.review-version.current", "Current"),
      ("studio.workspace.review-version.proposed", "Proposed"),
    ]
    for (identifier, label) in expected {
      let button = try XCTUnwrap(chrome.button(identifier: identifier))
      XCTAssertEqual(button.title, label)
      XCTAssertEqual(button.accessibilityLabel(), label)
      XCTAssertEqual(button.accessibilityRole(), .button)
    }

    XCTAssertEqual(workspace.window.title, "TaskWraith Studio")
  }

  func testRouteButtonsBindToAppStateAndRemainIndependent() throws {
    let workspace = try makeWorkspace()
    let review = try XCTUnwrap(workspace.reviewController)
    let state = StudioViewerAppState(
      controller: workspace.sourceController,
      renderer: workspace.sourceController.renderer,
      reviewController: review,
      workspaceController: workspace
    )
    _ = state
    workspace.show()

    let source = try XCTUnwrap(
      workspace.viewerDeckChrome.button(identifier: "studio.workspace.route.source")
    )
    let timeline = try XCTUnwrap(
      workspace.viewerDeckChrome.button(identifier: "studio.workspace.route.timeline")
    )
    XCTAssertEqual(source.state, .on)
    XCTAssertEqual(timeline.state, .off)

    timeline.performClick(nil)
    XCTAssertEqual(source.state, .on)
    XCTAssertEqual(timeline.state, .on)

    source.performClick(nil)
    XCTAssertEqual(source.state, .off)
    XCTAssertEqual(timeline.state, .on)
    XCTAssertTrue(review.isPresentationAttached)
  }

  func testABButtonsAreDisabledWithoutReviewAndMirrorTheRealController() throws {
    let workspace = try makeWorkspace()
    let review = try XCTUnwrap(workspace.reviewController)
    let state = StudioViewerAppState(
      controller: workspace.sourceController,
      renderer: workspace.sourceController.renderer,
      reviewController: review,
      workspaceController: workspace
    )
    _ = state
    let current = try XCTUnwrap(
      workspace.viewerDeckChrome.button(
        identifier: "studio.workspace.review-version.current"
      )
    )
    let proposed = try XCTUnwrap(
      workspace.viewerDeckChrome.button(
        identifier: "studio.workspace.review-version.proposed"
      )
    )

    XCTAssertFalse(current.isEnabled)
    XCTAssertFalse(proposed.isEnabled)
    XCTAssertEqual(current.state, .off)
    XCTAssertEqual(proposed.state, .off)

    review.adopt(reviewTimeline: makeReviewTimeline())

    XCTAssertTrue(current.isEnabled)
    XCTAssertTrue(proposed.isEnabled)
    XCTAssertEqual(current.state, .on)
    XCTAssertEqual(proposed.state, .off)

    proposed.performClick(nil)
    XCTAssertEqual(review.activeReviewContext?.version, .proposed)
    XCTAssertEqual(current.state, .off)
    XCTAssertEqual(proposed.state, .on)

    // A selected control is idempotent; it does not toggle the real context
    // away from the requested version just because it was pressed again.
    proposed.performClick(nil)
    XCTAssertEqual(review.activeReviewContext?.version, .proposed)
    XCTAssertEqual(current.state, .off)
    XCTAssertEqual(proposed.state, .on)

    current.performClick(nil)
    XCTAssertEqual(review.activeReviewContext?.version, .current)
    XCTAssertEqual(current.state, .on)
    XCTAssertEqual(proposed.state, .off)
  }

  func testKeyboardReviewShortcutRefreshesTheSameChromeState() throws {
    let workspace = try makeWorkspace()
    let review = try XCTUnwrap(workspace.reviewController)
    review.adopt(reviewTimeline: makeReviewTimeline())

    let current = try XCTUnwrap(
      workspace.viewerDeckChrome.button(
        identifier: "studio.workspace.review-version.current"
      )
    )
    let proposed = try XCTUnwrap(
      workspace.viewerDeckChrome.button(
        identifier: "studio.workspace.review-version.proposed"
      )
    )
    XCTAssertEqual(current.state, .on)
    XCTAssertEqual(proposed.state, .off)

    review.performReviewVersionShortcut()

    XCTAssertEqual(review.activeReviewContext?.version, .proposed)
    XCTAssertEqual(current.state, .off)
    XCTAssertEqual(proposed.state, .on)
  }
}
