import AppKit
import XCTest

@testable import TaskWraithStudioCompanion
@testable import TaskWraithStudioCore

@MainActor
final class StudioWorkspaceWindowTests: XCTestCase {
  private func makeWorkspace(
    includeReview: Bool = true
  ) throws -> StudioWorkspaceWindowController {
    guard let device = MTLCreateSystemDefaultDevice() else {
      throw XCTSkip("no Metal device")
    }
    let timebase = try XCTUnwrap(
      StudioTimebase(timescale: 600, frameDurationTicks: 20)
    )
    let reviewRenderer: StudioViewerRenderer? =
      includeReview
      ? try StudioViewerRenderer(device: device)
      : nil
    return StudioWorkspaceWindowController(
      sourceRenderer: try StudioViewerRenderer(device: device),
      reviewRenderer: reviewRenderer,
      authority: StudioPlaybackAuthority(
        clock: StudioPlaybackClock(timebase: timebase, durationTicks: 0)
      )
    )
  }

  func testOneWorkspaceWindowOwnsBothExistingRoutePresentations() throws {
    let workspace = try makeWorkspace()

    let review = try XCTUnwrap(workspace.reviewController)
    XCTAssertTrue(workspace.sourceController.window === workspace.window)
    XCTAssertTrue(review.window === workspace.window)
    XCTAssertTrue(
      workspace.sourceController.playbackAuthority === review.playbackAuthority,
      "embedding two route views must not manufacture a second playback clock"
    )
    XCTAssertFalse(workspace.sourceController.isPresentationAttached)
    XCTAssertFalse(try XCTUnwrap(workspace.reviewController).isPresentationAttached)

    workspace.update(
      visibleRoutes: [.source, .review],
      sequence: nil,
      activeProposalId: nil,
      viewport: try XCTUnwrap(StudioWorkspaceViewport(width: 1_600, height: 900))
    )
    workspace.show()

    XCTAssertTrue(workspace.sourceController.isPresentationAttached)
    XCTAssertTrue(try XCTUnwrap(workspace.reviewController).isPresentationAttached)
    XCTAssertTrue(workspace.window.isVisible)
    XCTAssertFalse(workspace.window.isKeyWindow)
    XCTAssertEqual(workspace.lastSnapshot.viewerPresentation, .dual)
    XCTAssertEqual(workspace.lastSnapshot.primaryWindowCount, 1)
  }

  func testClosingWorkspaceDetachesBothRoutePresentations() throws {
    let workspace = try makeWorkspace()
    let review = try XCTUnwrap(workspace.reviewController)
    workspace.update(
      visibleRoutes: [.source, .review],
      sequence: nil,
      activeProposalId: nil,
      viewport: try XCTUnwrap(StudioWorkspaceViewport(width: 1_600, height: 900))
    )
    workspace.show()

    workspace.window.close()

    XCTAssertFalse(workspace.sourceController.isPresentationAttached)
    XCTAssertFalse(review.isPresentationAttached)
  }

  func testClosedWorkspaceIgnoresBackgroundRefreshUntilExplicitShow() throws {
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

    workspace.update(
      visibleRoutes: [.source, .review],
      sequence: StudioTimelineSequence(items: [
        StudioSequenceItem(
          itemId: "clip-after-close",
          assetId: "asset-after-close",
          startTicks: 0,
          endTicks: 600,
          sourceInTicks: 0
        )
      ]),
      activeProposalId: "proposal-after-close",
      viewport: viewport
    )

    XCTAssertFalse(workspace.sourceController.isPresentationAttached)
    XCTAssertFalse(review.isPresentationAttached)
    XCTAssertFalse(workspace.window.isVisible)

    workspace.show()

    XCTAssertTrue(workspace.sourceController.isPresentationAttached)
    XCTAssertTrue(review.isPresentationAttached)
    XCTAssertTrue(workspace.window.isVisible)
  }

  func testUnavailableReviewNormalizesReviewOnlyNarrowWorkspaceToSource() throws {
    let workspace = try makeWorkspace(includeReview: false)
    XCTAssertNil(workspace.reviewController)

    workspace.setActiveRoute(.review)
    workspace.update(
      visibleRoutes: [.review],
      sequence: nil,
      activeProposalId: nil,
      viewport: try XCTUnwrap(StudioWorkspaceViewport(width: 800, height: 900))
    )
    workspace.show()

    XCTAssertEqual(workspace.lastSnapshot.viewerPresentation, .single(.source))
    XCTAssertTrue(workspace.routeHostIsVisible(.source))
    XCTAssertFalse(workspace.routeHostIsVisible(.review))
    XCTAssertTrue(workspace.sourceController.isPresentationAttached)
  }

  func testWorkspaceHierarchyUsesTheLockedLiteralPaneOrder() throws {
    let workspace = try makeWorkspace()

    XCTAssertEqual(
      workspace.upperPaneIdentifiers,
      [
        "studio.workspace.browser",
        "studio.workspace.viewer-deck",
        "studio.workspace.inspector",
      ]
    )
    XCTAssertEqual(
      workspace.lowerPaneIdentifiers,
      [
        "studio.workspace.transcript",
        "studio.workspace.timeline",
        "studio.workspace.proposal-bar",
      ]
    )
    XCTAssertEqual(workspace.exportActionTitle, "Export Timeline…")
  }

  func testResponsiveSingleViewDoesNotRewriteExplicitRouteOwnership() throws {
    let workspace = try makeWorkspace()
    let review = try XCTUnwrap(workspace.reviewController)
    workspace.update(
      visibleRoutes: [.source, .review],
      sequence: nil,
      activeProposalId: nil,
      viewport: try XCTUnwrap(StudioWorkspaceViewport(width: 1_600, height: 900))
    )
    workspace.show()

    workspace.setActiveRoute(.review)
    workspace.update(
      visibleRoutes: [.source, .review],
      sequence: nil,
      activeProposalId: nil,
      viewport: try XCTUnwrap(StudioWorkspaceViewport(width: 800, height: 900))
    )

    XCTAssertEqual(workspace.lastSnapshot.viewerPresentation, .single(.review))
    XCTAssertTrue(workspace.sourceController.isPresentationAttached)
    XCTAssertTrue(review.isPresentationAttached)
    XCTAssertFalse(workspace.routeHostIsVisible(.source))
    XCTAssertTrue(workspace.routeHostIsVisible(.review))

    workspace.update(
      visibleRoutes: [.review],
      sequence: nil,
      activeProposalId: nil,
      viewport: try XCTUnwrap(StudioWorkspaceViewport(width: 800, height: 900))
    )

    XCTAssertFalse(workspace.sourceController.isPresentationAttached)
    XCTAssertTrue(review.isPresentationAttached)
    XCTAssertTrue(
      workspace.window.isVisible,
      "hiding Source must not order out the one shared workspace window"
    )
  }

  func testWorkspaceSnapshotUsesCurrentHostClipAndProposalIdentities() throws {
    let workspace = try makeWorkspace()
    let viewport = try XCTUnwrap(StudioWorkspaceViewport(width: 1_600, height: 900))
    let clipA = StudioSequenceItem(
      itemId: "clip-a",
      assetId: "asset-a",
      startTicks: 0,
      endTicks: 600,
      sourceInTicks: 0
    )
    let clipB = StudioSequenceItem(
      itemId: "clip-b",
      assetId: "asset-b",
      startTicks: 600,
      endTicks: 1_200,
      sourceInTicks: 0
    )

    XCTAssertTrue(workspace.selectClip(id: clipA.itemId))
    workspace.setInspectorSection(.clip)
    workspace.update(
      visibleRoutes: [.source],
      sequence: StudioTimelineSequence(items: [clipA]),
      activeProposalId: nil,
      viewport: viewport
    )
    XCTAssertEqual(
      workspace.lastSnapshot.inspectorContent,
      .clip(id: "clip-a", section: .clip)
    )

    workspace.update(
      visibleRoutes: [.source],
      sequence: StudioTimelineSequence(items: [clipB]),
      activeProposalId: nil,
      viewport: viewport
    )
    XCTAssertEqual(workspace.lastSnapshot.inspectorContent, .empty(section: .clip))

    workspace.setInspectorSection(.proposal)
    XCTAssertTrue(workspace.selectProposal(id: "proposal-1"))
    workspace.update(
      visibleRoutes: [.source],
      sequence: StudioTimelineSequence(items: [clipB]),
      activeProposalId: "proposal-1",
      viewport: viewport
    )
    XCTAssertTrue(workspace.lastSnapshot.proposalBarVisible)
    XCTAssertEqual(workspace.lastSnapshot.inspectorContent, .proposal(id: "proposal-1"))

    workspace.update(
      visibleRoutes: [.source],
      sequence: StudioTimelineSequence(items: [clipB]),
      activeProposalId: nil,
      viewport: viewport
    )
    XCTAssertFalse(workspace.lastSnapshot.proposalBarVisible)
    XCTAssertEqual(workspace.lastSnapshot.inspectorContent, .empty(section: .proposal))
  }

  func testAppStatePublishesAuthoritativeSequenceItemIdentities() async throws {
    let workspace = try makeWorkspace()
    let review = try XCTUnwrap(workspace.reviewController)
    let state = StudioViewerAppState(
      controller: workspace.sourceController,
      renderer: workspace.sourceController.renderer,
      reviewController: review,
      workspaceController: workspace
    )
    workspace.setInspectorSection(.clip)
    XCTAssertTrue(workspace.selectClip(id: "clip-a"))

    await state.adopt(
      sequence: StudioTimelineSequence(items: [
        StudioSequenceItem(
          itemId: "clip-a",
          assetId: "asset-a",
          startTicks: 0,
          endTicks: 600,
          sourceInTicks: 0
        )
      ])
    )
    XCTAssertEqual(
      workspace.lastSnapshot.inspectorContent,
      .clip(id: "clip-a", section: .clip)
    )

    await state.adopt(
      sequence: StudioTimelineSequence(items: [
        StudioSequenceItem(
          itemId: "clip-b",
          assetId: "asset-b",
          startTicks: 0,
          endTicks: 600,
          sourceInTicks: 0
        )
      ])
    )
    XCTAssertEqual(workspace.lastSnapshot.inspectorContent, .empty(section: .clip))
  }

  func testAppStateRouteToggleDetachesOnlyTheHiddenWorkspaceRoute() throws {
    let workspace = try makeWorkspace()
    let review = try XCTUnwrap(workspace.reviewController)
    let state = StudioViewerAppState(
      controller: workspace.sourceController,
      renderer: workspace.sourceController.renderer,
      reviewController: review,
      workspaceController: workspace
    )
    workspace.show()

    XCTAssertEqual(state.toggleRoute(.review), .shown(.review))
    XCTAssertTrue(review.isPresentationAttached)
    XCTAssertEqual(state.toggleRoute(.review), .hidden(.review))

    XCTAssertTrue(workspace.sourceController.isPresentationAttached)
    XCTAssertFalse(review.isPresentationAttached)
    XCTAssertTrue(workspace.window.isVisible)
  }
}
