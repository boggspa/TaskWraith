import AppKit
import XCTest

@testable import TaskWraithStudioCompanion
@testable import TaskWraithStudioCore

@MainActor
final class StudioWorkspaceWindowTests: XCTestCase {
  private func descendant(
    of root: NSView,
    identifier: String
  ) -> NSView? {
    if root.identifier?.rawValue == identifier { return root }
    for child in root.subviews {
      if let match = descendant(of: child, identifier: identifier) { return match }
    }
    return nil
  }

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

  private func makeReviewTimeline() -> StudioProposedTimeline {
    let timebase = StudioTimebase(timescale: 600, frameDurationTicks: 20)!
    let op = StudioInsertRangeOp(
      itemId: "insert-workspace-focus",
      assetId: "asset-inserted",
      trackId: nil,
      sourceIn: StudioRationalTime(n: 0, d: 600)!,
      sourceOut: StudioRationalTime(n: 600, d: 600)!,
      at: StudioRationalTime(n: 1_200, d: 600)!
    )
    return StudioProposedTimeline(
      proposal: StudioEditProposal(
        proposalId: "proposal-workspace-focus",
        createdRevision: 1,
        op: op
      ),
      timebase: timebase
    )!
  }

  private func makeKeyEvent(
    in window: NSWindow,
    characters: String,
    keyCode: UInt16
  ) -> NSEvent {
    NSEvent.keyEvent(
      with: .keyDown,
      location: .zero,
      modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: window.windowNumber,
      context: nil,
      characters: characters,
      charactersIgnoringModifiers: characters,
      isARepeat: false,
      keyCode: keyCode
    )!
  }

  func testOneWorkspaceWindowOwnsBothExistingRoutePresentations() throws {
    if ProcessInfo.processInfo.environment["CI"] != nil {
        throw XCTSkip(
            "needs a real GPU and window server; hosted CI runners are headless "
            + "and their Paravirtual Metal device allocates differently"
        )
    }
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

  func testVisibleSourceHostOccupiesPositiveAreaInsideWorkspaceContent() throws {
    let workspace = try makeWorkspace()
    workspace.update(
      visibleRoutes: [.source],
      sequence: nil,
      activeProposalId: nil,
      viewport: try XCTUnwrap(StudioWorkspaceViewport(width: 1_280, height: 800))
    )
    workspace.show()
    workspace.window.contentView?.layoutSubtreeIfNeeded()

    let content = try XCTUnwrap(workspace.window.contentView)
    let sourceHost = try XCTUnwrap(
      descendant(of: content, identifier: "studio.workspace.viewer.source")
    )
    let frame = sourceHost.convert(sourceHost.bounds, to: content)
    let accessibilityFrame = sourceHost.accessibilityFrame()
    XCTAssertFalse(sourceHost.isHidden)
    XCTAssertTrue(
      workspace.sourceController.isPresentationFirstResponder,
      "the visible route must receive explicit keyboard input in the one-window workspace"
    )
    XCTAssertFalse(content.hasAmbiguousLayout)
    XCTAssertEqual(
      sourceHost.accessibilityIdentifier(),
      "studio.workspace.viewer.source"
    )
    XCTAssertGreaterThan(frame.width, 0)
    XCTAssertGreaterThan(frame.height, 0)
    XCTAssertGreaterThanOrEqual(
      frame.width,
      content.bounds.width * 0.5,
      "the one-window viewer deck must remain wide enough for visible media identity"
    )
    XCTAssertGreaterThan(accessibilityFrame.width, 0)
    XCTAssertGreaterThan(accessibilityFrame.height, 0)
    XCTAssertTrue(content.bounds.contains(frame))
  }

  func testNewlyVisibleActiveRouteReceivesKeyboardInput() throws {
    let workspace = try makeWorkspace()
    let review = try XCTUnwrap(workspace.reviewController)
    let viewport = try XCTUnwrap(StudioWorkspaceViewport(width: 1_280, height: 800))
    workspace.update(
      visibleRoutes: [.source],
      sequence: nil,
      activeProposalId: nil,
      viewport: viewport
    )
    workspace.show()
    XCTAssertTrue(workspace.sourceController.isPresentationFirstResponder)

    // Route activation precedes the host-visible route projection in the app
    // state. Remember that keyboard target until the newly visible route has
    // actually attached to the shared workspace window.
    workspace.setActiveRoute(.review)
    workspace.update(
      visibleRoutes: [.source, .review],
      sequence: nil,
      activeProposalId: nil,
      viewport: viewport
    )

    XCTAssertEqual(workspace.lastSnapshot.viewerPresentation, .single(.review))
    XCTAssertTrue(workspace.routeHostIsVisible(.review))
    XCTAssertTrue(
      review.isPresentationFirstResponder,
      "the active visible route must receive the next keyboard shortcut"
    )

    review.adopt(reviewTimeline: makeReviewTimeline())
    XCTAssertEqual(review.activeReviewContext?.version, .current)
    workspace.window.sendEvent(
      makeKeyEvent(in: workspace.window, characters: "v", keyCode: 9)
    )
    XCTAssertEqual(
      review.activeReviewContext?.version,
      .proposed,
      "the focused Review route must handle the real v key event"
    )

    workspace.window.close()
    workspace.show()
    XCTAssertTrue(
      review.isPresentationFirstResponder,
      "reopening must restore keyboard focus to the still-active Review route"
    )
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

  func testViewerDeckChromeProjectsExplicitWorkspaceRoutes() throws {
    let workspace = try makeWorkspace()
    let viewport = try XCTUnwrap(StudioWorkspaceViewport(width: 1_600, height: 900))
    workspace.update(
      visibleRoutes: [.source, .review],
      sequence: nil,
      activeProposalId: nil,
      viewport: viewport
    )

    let source = try XCTUnwrap(
      workspace.viewerDeckChrome.button(identifier: "studio.workspace.route.source")
    )
    let timeline = try XCTUnwrap(
      workspace.viewerDeckChrome.button(identifier: "studio.workspace.route.timeline")
    )
    XCTAssertEqual(source.state, .on)
    XCTAssertEqual(timeline.state, .on)

    workspace.update(
      visibleRoutes: [.review],
      sequence: nil,
      activeProposalId: nil,
      viewport: viewport
    )
    XCTAssertEqual(source.state, .off)
    XCTAssertEqual(timeline.state, .on)
  }
}
