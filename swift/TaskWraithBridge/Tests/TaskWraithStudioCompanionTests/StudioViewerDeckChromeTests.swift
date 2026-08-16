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

  private func makeWorkspace(
    audioPlayer: StudioAudioPlayer?,
    audioSchedulingAuthority: StudioAudioSchedulingAuthority?
  ) throws -> StudioWorkspaceWindowController {
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
      ),
      audioPlayer: audioPlayer,
      audioSchedulingAuthority: audioSchedulingAuthority
    )
  }

  private func view(identifier: String, in root: NSView) -> NSView? {
    if root.identifier?.rawValue == identifier {
      return root
    }
    for child in root.subviews {
      if let match = view(identifier: identifier, in: child) {
        return match
      }
    }
    return nil
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
    XCTAssertEqual(workspace.window.contentView?.identifier?.rawValue, "studio.workspace.root")
    XCTAssertEqual(workspace.window.contentView?.accessibilityRole(), .group)
    XCTAssertEqual(workspace.window.contentView?.accessibilityLabel(), "Studio workspace")

    let expected: [(String, String, NSAccessibility.Role)] = [
      ("studio.workspace.route.source", "Source", .checkBox),
      ("studio.workspace.route.timeline", "Timeline", .checkBox),
      ("studio.workspace.review-version.current", "Current", .radioButton),
      ("studio.workspace.review-version.proposed", "Proposed", .radioButton),
    ]
    for (identifier, label, role) in expected {
      let button = try XCTUnwrap(chrome.button(identifier: identifier))
      XCTAssertEqual(button.title, label)
      XCTAssertEqual(button.accessibilityLabel(), label)
      XCTAssertEqual(button.accessibilityRole(), role)
    }

    for (identifier, label) in [
      ("studio.workspace.viewer.source", "Source viewer"),
      ("studio.workspace.viewer.timeline", "Timeline viewer"),
    ] {
      let host = try XCTUnwrap(view(identifier: identifier, in: workspace.window.contentView!))
      XCTAssertEqual(host.accessibilityLabel(), label)
      XCTAssertEqual(host.accessibilityRole(), .group)
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

  func testSoleVisibleRouteRefusalKeepsChromeAndPresentationAttached() throws {
    let workspace = try makeWorkspace()
    let state = StudioViewerAppState(
      controller: workspace.sourceController,
      renderer: workspace.sourceController.renderer,
      reviewController: try XCTUnwrap(workspace.reviewController),
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
    XCTAssertTrue(workspace.sourceController.isPresentationAttached)

    source.performClick(nil)

    XCTAssertEqual(source.state, .on)
    XCTAssertEqual(timeline.state, .off)
    XCTAssertTrue(workspace.sourceController.isPresentationAttached)
  }

  func testCompactHostVisibilityDoesNotRewriteIndependentRouteSelection() throws {
    let workspace = try makeWorkspace()
    let viewport = try XCTUnwrap(StudioWorkspaceViewport(width: 1_600, height: 900))
    workspace.update(
      visibleRoutes: [.source, .review],
      sequence: nil,
      activeProposalId: nil,
      viewport: viewport
    )
    workspace.show()

    workspace.setActiveRoute(.review)
    workspace.update(
      visibleRoutes: [.source, .review],
      sequence: nil,
      activeProposalId: nil,
      viewport: try XCTUnwrap(StudioWorkspaceViewport(width: 800, height: 900))
    )

    let source = try XCTUnwrap(
      workspace.viewerDeckChrome.button(identifier: "studio.workspace.route.source")
    )
    let timeline = try XCTUnwrap(
      workspace.viewerDeckChrome.button(identifier: "studio.workspace.route.timeline")
    )
    XCTAssertEqual(source.state, .on)
    XCTAssertEqual(timeline.state, .on)
    XCTAssertFalse(workspace.routeHostIsVisible(.source))
    XCTAssertTrue(workspace.routeHostIsVisible(.review))
    XCTAssertTrue(workspace.sourceController.isPresentationAttached)
    XCTAssertTrue(try XCTUnwrap(workspace.reviewController).isPresentationAttached)
  }

  func testClosedWorkspaceRefreshesChromeWithoutReattachingUntilExplicitShow() throws {
    let workspace = try makeWorkspace()
    let review = try XCTUnwrap(workspace.reviewController)
    let viewport = try XCTUnwrap(StudioWorkspaceViewport(width: 1_600, height: 900))
    workspace.update(
      visibleRoutes: [.source, .review],
      sequence: nil,
      activeProposalId: nil,
      viewport: viewport
    )
    workspace.show()
    workspace.window.close()

    review.adopt(reviewTimeline: makeReviewTimeline())
    let proposed = try XCTUnwrap(
      workspace.viewerDeckChrome.button(
        identifier: "studio.workspace.review-version.proposed"
      )
    )
    XCTAssertTrue(proposed.isEnabled)
    XCTAssertFalse(workspace.sourceController.isPresentationAttached)
    XCTAssertFalse(review.isPresentationAttached)

    workspace.update(
      visibleRoutes: [.source, .review],
      sequence: nil,
      activeProposalId: "background-refresh",
      viewport: viewport
    )
    XCTAssertFalse(workspace.sourceController.isPresentationAttached)
    XCTAssertFalse(review.isPresentationAttached)

    workspace.show()
    XCTAssertTrue(workspace.sourceController.isPresentationAttached)
    XCTAssertTrue(review.isPresentationAttached)
  }

  func testABTogglePreservesSharedPlaybackAndBoundedResourceOwnership() throws {
    let sharedPlayer = StudioAudioPlayer()
    let scheduling = StudioAudioSchedulingAuthority(owner: .source)
    let workspace = try makeWorkspace(
      audioPlayer: sharedPlayer,
      audioSchedulingAuthority: scheduling
    )
    let review = try XCTUnwrap(workspace.reviewController)
    let state = StudioViewerAppState(
      controller: workspace.sourceController,
      renderer: workspace.sourceController.renderer,
      reviewController: review,
      workspaceController: workspace
    )
    workspace.show()
    XCTAssertEqual(state.toggleRoute(.review), .shown(.review))
    review.adopt(reviewTimeline: makeReviewTimeline())

    let authority = workspace.sourceController.playbackAuthority
    authority.transport.play(atHost: 10)
    let before = authority.transport.clock.snapshot(atHost: 10.5)
    let authorityIdentity = ObjectIdentifier(authority)
    let playerIdentity = workspace.sourceController.audioPlayerIdentity
    let decoderCreations = state.sharedDecoderCreationCount
    let residentDecoders = state.sharedResidentDecoderCount
    let schedulingOwner = workspace.sourceController.audioSchedulingOwner

    let proposed = try XCTUnwrap(
      workspace.viewerDeckChrome.button(
        identifier: "studio.workspace.review-version.proposed"
      )
    )
    proposed.performClick(nil)

    let after = authority.transport.clock.snapshot(atHost: 10.5)
    XCTAssertTrue(authority === review.playbackAuthority)
    XCTAssertEqual(ObjectIdentifier(review.playbackAuthority), authorityIdentity)
    XCTAssertEqual(review.audioPlayerIdentity, playerIdentity)
    XCTAssertEqual(review.audioSchedulingOwner, schedulingOwner)
    XCTAssertEqual(before, after)
    XCTAssertEqual(state.sharedDecoderCreationCount, decoderCreations)
    XCTAssertEqual(state.sharedResidentDecoderCount, residentDecoders)
    XCTAssertLessThanOrEqual(state.sharedResidentDecoderCount, 1)
  }

  func testMomentaryControlsCannotClaimSelectionWithoutOwnerConfirmation() throws {
    let chrome = StudioViewerDeckChrome(frame: .zero)
    chrome.update(visibleRoutes: [.source], reviewContext: nil)

    let source = try XCTUnwrap(
      chrome.button(identifier: "studio.workspace.route.source")
    )
    XCTAssertEqual(source.state, .on)
    XCTAssertEqual(source.accessibilityValue() as? String, "selected")

    // No owner callback is installed. A route control must remain exactly as
    // projected rather than optimistically changing its local state.
    source.performClick(nil)
    XCTAssertEqual(source.state, .on)
    XCTAssertEqual(source.accessibilityValue() as? String, "selected")

    let timebase = try XCTUnwrap(
      StudioTimebase(timescale: 600, frameDurationTicks: 20)
    )
    chrome.update(
      visibleRoutes: [.source],
      reviewContext: StudioReviewContext(
        version: .current,
        timeline: makeReviewTimeline(),
        timebase: timebase
      )
    )

    let proposed = try XCTUnwrap(
      chrome.button(identifier: "studio.workspace.review-version.proposed")
    )
    XCTAssertEqual(proposed.state, .off)
    XCTAssertEqual(proposed.accessibilityValue() as? String, "not selected")

    // The A/B control also has no owner callback. Pressing it must not claim
    // Proposed until the host sends a new review-context projection.
    proposed.performClick(nil)
    XCTAssertEqual(proposed.state, .off)
    XCTAssertEqual(proposed.accessibilityValue() as? String, "not selected")
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
