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

  private func routeResourceElements(
    in workspace: StudioWorkspaceWindowController
  ) throws -> [NSAccessibilityElement] {
    let identifiers = Set([
      StudioWorkspaceRootStack.sourceRouteResourceIdentifier,
      StudioWorkspaceRootStack.reviewRouteResourceIdentifier,
    ])
    var frontier = NSAccessibility.unignoredChildren(
      from: workspace.window.accessibilityChildren() ?? []
    )
    var matches: [NSAccessibilityElement] = []
    var depth = 0
    while !frontier.isEmpty, depth < 8 {
      var next: [Any] = []
      for node in frontier {
        if let element = node as? NSAccessibilityElement,
          element.accessibilityIdentifier().map(identifiers.contains) == true
        {
          matches.append(element)
        }
        if let children = (node as AnyObject).accessibilityChildren?() {
          next.append(contentsOf: NSAccessibility.unignoredChildren(from: children))
        }
      }
      frontier = next
      depth += 1
    }
    return matches
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

  func testSourceAndReviewShareTheAppStateResourceDetailProvider() throws {
    let workspace = try makeWorkspace()
    let state = StudioViewerAppState(
      controller: workspace.sourceController,
      renderer: workspace.sourceController.renderer,
      reviewController: workspace.reviewController,
      workspaceController: workspace
    )
    let sourceDetail = workspace.sourceController.currentResourceDetailForTesting
    let reviewDetail = workspace.reviewController?.currentResourceDetailForTesting
    XCTAssertEqual(sourceDetail, reviewDetail)
    XCTAssertEqual(sourceDetail, state.resourceDetail)
    XCTAssertTrue(sourceDetail?.hasPrefix("res1 dec=") == true)
  }

  func testSourceAndReviewRouteResourceProvidersReadOnlyTheirOwnRenderer() throws {
    let workspace = try makeWorkspace()
    let review = try XCTUnwrap(workspace.reviewController)
    _ = StudioViewerAppState(
      controller: workspace.sourceController,
      renderer: workspace.sourceController.renderer,
      reviewController: review,
      workspaceController: workspace
    )

    let defaultSource = try StudioRouteResourceSnapshot(
      diagnosticsExportText: try XCTUnwrap(
        workspace.sourceController.currentRouteResourceDetailForTesting
      )
    )
    let defaultReview = try StudioRouteResourceSnapshot(
      diagnosticsExportText: try XCTUnwrap(
        review.currentRouteResourceDetailForTesting
      )
    )

    XCTAssertEqual(defaultSource.route, .source)
    XCTAssertEqual(
      defaultSource.activeSourceCount,
      workspace.sourceController.renderer.activeSourceCount
    )
    XCTAssertEqual(
      defaultSource.retainedFrameCount,
      workspace.sourceController.renderer.retainedFrameCount
    )
    XCTAssertEqual(
      defaultSource.capacity,
      workspace.sourceController.renderer.liveIOSurfaceCapacity
    )
    XCTAssertEqual(
      defaultSource.surfaceIDs,
      workspace.sourceController.renderer.liveIOSurfaceIDs
    )
    XCTAssertEqual(defaultReview.route, .review)
    XCTAssertEqual(defaultReview.activeSourceCount, review.renderer.activeSourceCount)
    XCTAssertEqual(defaultReview.retainedFrameCount, review.renderer.retainedFrameCount)
    XCTAssertEqual(defaultReview.capacity, review.renderer.liveIOSurfaceCapacity)
    XCTAssertEqual(defaultReview.surfaceIDs, review.renderer.liveIOSurfaceIDs)
    XCTAssertEqual(
      defaultReview.diagnosticsExportText,
      "rr1 route=review active=0 retained=0 cap=0 surf=0 ids=-",
      "an empty hidden Review renderer must not inherit Source or shared-pool resources"
    )

    workspace.sourceController.replaceRouteResourceSnapshotProviderForTesting {
      StudioRouteResourceSnapshot(
        route: .source,
        activeSourceCount: 1,
        retainedFrameCount: 1,
        capacity: 4,
        surfaceIDs: [0x0A]
      )
    }
    review.replaceRouteResourceSnapshotProviderForTesting {
      StudioRouteResourceSnapshot(
        route: .review,
        activeSourceCount: 2,
        retainedFrameCount: 0,
        capacity: 8,
        surfaceIDs: [0x0B, 0x0C]
      )
    }
    let source = try StudioRouteResourceSnapshot(
      diagnosticsExportText: try XCTUnwrap(
        workspace.sourceController.currentRouteResourceDetailForTesting
      )
    )
    let reviewSnapshot = try StudioRouteResourceSnapshot(
      diagnosticsExportText: try XCTUnwrap(
        review.currentRouteResourceDetailForTesting
      )
    )
    XCTAssertEqual(source.surfaceIDs, [0x0A])
    XCTAssertEqual(source.activeSourceCount, 1)
    XCTAssertEqual(source.retainedFrameCount, 1)
    XCTAssertEqual(source.capacity, 4)
    XCTAssertEqual(reviewSnapshot.surfaceIDs, [0x0B, 0x0C])
    XCTAssertEqual(reviewSnapshot.activeSourceCount, 2)
    XCTAssertEqual(reviewSnapshot.retainedFrameCount, 0)
    XCTAssertEqual(reviewSnapshot.capacity, 8)
    XCTAssertNotEqual(source.diagnosticsExportText, reviewSnapshot.diagnosticsExportText)
  }

  func testWorkspaceRouteResourceElementsSurviveHideShowAndResponsiveLayouts() throws {
    let workspace = try makeWorkspace()
    let review = try XCTUnwrap(workspace.reviewController)
    var sourceReading = StudioRouteResourceSnapshot(
      route: .source,
      activeSourceCount: 1,
      retainedFrameCount: 1,
      capacity: 4,
      surfaceIDs: [0x0A]
    )
    var reviewReading = StudioRouteResourceSnapshot(
      route: .review,
      activeSourceCount: 2,
      retainedFrameCount: 1,
      capacity: 8,
      surfaceIDs: [0x0B, 0x0C]
    )
    workspace.sourceController.replaceRouteResourceSnapshotProviderForTesting {
      sourceReading
    }
    review.replaceRouteResourceSnapshotProviderForTesting { reviewReading }

    let wide = try XCTUnwrap(StudioWorkspaceViewport(width: 1_600, height: 900))
    workspace.update(
      visibleRoutes: [.source, .review],
      sequence: nil,
      activeProposalId: nil,
      viewport: wide
    )
    workspace.show()

    let initial = try routeResourceElements(in: workspace)
    XCTAssertEqual(
      initial.compactMap { $0.accessibilityIdentifier() },
      [
        StudioWorkspaceRootStack.sourceRouteResourceIdentifier,
        StudioWorkspaceRootStack.reviewRouteResourceIdentifier,
      ]
    )
    XCTAssertEqual(
      initial.compactMap { $0.accessibilityLabel() },
      ["Source route resource detail", "Review route resource detail"]
    )
    XCTAssertTrue(initial.allSatisfy { $0.accessibilityRole() == .staticText })
    XCTAssertEqual(
      initial.compactMap { $0.accessibilityValue() as? String },
      [sourceReading.diagnosticsExportText, reviewReading.diagnosticsExportText]
    )
    let identities = initial.map(ObjectIdentifier.init)
    let retainedSourceElement = initial[0]
    let retainedReviewElement = initial[1]

    reviewReading = StudioRouteResourceSnapshot(
      route: .review,
      activeSourceCount: 0,
      retainedFrameCount: 0,
      capacity: 0,
      surfaceIDs: []
    )
    workspace.update(
      visibleRoutes: [.source],
      sequence: nil,
      activeProposalId: nil,
      viewport: wide
    )
    XCTAssertFalse(workspace.routeHostIsVisible(.review))
    XCTAssertEqual(
      retainedReviewElement.accessibilityValue() as? String,
      "rr1 route=review active=0 retained=0 cap=0 surf=0 ids=-",
      "a retained AX element must read the current hidden-route value"
    )
    let hidden = try routeResourceElements(in: workspace)
    XCTAssertEqual(hidden.map(ObjectIdentifier.init), identities)
    XCTAssertEqual(hidden[0].accessibilityValue() as? String, sourceReading.diagnosticsExportText)
    XCTAssertEqual(
      hidden[1].accessibilityValue() as? String,
      "rr1 route=review active=0 retained=0 cap=0 surf=0 ids=-"
    )

    reviewReading = StudioRouteResourceSnapshot(
      route: .review,
      activeSourceCount: 1,
      retainedFrameCount: 0,
      capacity: 6,
      surfaceIDs: [0x0D]
    )
    for width in [800.0, 1_600.0] {
      workspace.update(
        visibleRoutes: [.source, .review],
        sequence: nil,
        activeProposalId: nil,
        viewport: try XCTUnwrap(StudioWorkspaceViewport(width: width, height: 900))
      )
      let responsive = try routeResourceElements(in: workspace)
      XCTAssertEqual(responsive.map(ObjectIdentifier.init), identities, "width \(width)")
      XCTAssertEqual(
        responsive.compactMap { $0.accessibilityIdentifier() },
        initial.compactMap { $0.accessibilityIdentifier() },
        "width \(width)"
      )
      XCTAssertEqual(
        responsive[0].accessibilityValue() as? String,
        sourceReading.diagnosticsExportText,
        "width \(width)"
      )
      XCTAssertEqual(
        responsive[1].accessibilityValue() as? String,
        reviewReading.diagnosticsExportText,
        "width \(width)"
      )
    }

    sourceReading = StudioRouteResourceSnapshot(
      route: .source,
      activeSourceCount: 1,
      retainedFrameCount: 0,
      capacity: 4,
      surfaceIDs: [0x0E]
    )
    XCTAssertEqual(
      retainedSourceElement.accessibilityValue() as? String,
      sourceReading.diagnosticsExportText,
      "a retained AX element must read the current Source value"
    )
    let sourceUpdated = try routeResourceElements(in: workspace)
    XCTAssertEqual(sourceUpdated.map(ObjectIdentifier.init), identities)
    XCTAssertEqual(
      sourceUpdated[0].accessibilityValue() as? String,
      sourceReading.diagnosticsExportText
    )
    XCTAssertEqual(
      sourceUpdated[1].accessibilityValue() as? String,
      reviewReading.diagnosticsExportText,
      "Source updates must not alias or replace Review evidence"
    )
  }

  func testUnavailableReviewStillPublishesCanonicalWorkspaceResourceZero() throws {
    let workspace = try makeWorkspace(includeReview: false)
    let resources = try routeResourceElements(in: workspace)
    XCTAssertEqual(resources.count, 2)
    XCTAssertEqual(
      resources[1].accessibilityValue() as? String,
      "rr1 route=review active=0 retained=0 cap=0 surf=0 ids=-"
    )
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

  func testViewerFirstGeometryAcrossEveryResponsiveBreakpoint() throws {
    let workspace = try makeWorkspace()
    workspace.show()

    struct LayoutCase {
      let width: CGFloat
      let browserVisible: Bool
      let inspectorVisible: Bool
    }
    let cases = [
      LayoutCase(width: 800, browserVisible: false, inspectorVisible: false),
      LayoutCase(width: 899, browserVisible: false, inspectorVisible: false),
      LayoutCase(width: 900, browserVisible: true, inspectorVisible: false),
      LayoutCase(width: 1_299, browserVisible: true, inspectorVisible: false),
      LayoutCase(width: 1_300, browserVisible: true, inspectorVisible: true),
      LayoutCase(width: 1_600, browserVisible: true, inspectorVisible: true),
    ]

    for item in cases {
      workspace.window.setContentSize(NSSize(width: item.width, height: 800))
      workspace.update(
        visibleRoutes: [.source],
        sequence: nil,
        activeProposalId: nil,
        viewport: try XCTUnwrap(
          StudioWorkspaceViewport(width: item.width, height: 800)
        )
      )
      workspace.window.contentView?.layoutSubtreeIfNeeded()

      let content = try XCTUnwrap(workspace.window.contentView)
      let toolbar = try XCTUnwrap(
        descendant(of: content, identifier: StudioWorkspaceToolbarView.identifier)
      )
      let editorDeck = try XCTUnwrap(
        descendant(of: content, identifier: "studio.workspace.editor-deck")
      )
      let upperDeck = try XCTUnwrap(
        descendant(of: content, identifier: "studio.workspace.upper-deck")
      )
      let lowerDeck = try XCTUnwrap(
        descendant(of: content, identifier: "studio.workspace.lower-deck")
      )
      let browser = try XCTUnwrap(
        descendant(of: content, identifier: "studio.workspace.browser")
      )
      let viewer = try XCTUnwrap(
        descendant(of: content, identifier: "studio.workspace.viewer-deck")
      )
      let inspector = try XCTUnwrap(
        descendant(of: content, identifier: "studio.workspace.inspector")
      )
      let transcript = try XCTUnwrap(
        descendant(of: content, identifier: "studio.workspace.transcript")
      )

      XCTAssertFalse(content.hasAmbiguousLayout, "width \(item.width)")
      XCTAssertEqual(toolbar.frame.height, StudioWorkspaceSurfaceMetrics.toolbarHeight, accuracy: 0.5)
      XCTAssertEqual(
        upperDeck.frame.height,
        editorDeck.frame.height * StudioWorkspaceSurfaceMetrics.upperDeckFraction,
        accuracy: 0.5,
        "width \(item.width)"
      )
      XCTAssertGreaterThan(lowerDeck.frame.height, 120)
      XCTAssertEqual(
        transcript.frame.height,
        StudioWorkspaceSurfaceMetrics.transcriptHeight,
        accuracy: 0.5
      )
      XCTAssertEqual(browser.isHidden, !item.browserVisible, "width \(item.width)")
      XCTAssertEqual(inspector.isHidden, !item.inspectorVisible, "width \(item.width)")
      if item.browserVisible {
        XCTAssertEqual(
          browser.frame.width,
          StudioWorkspaceSurfaceMetrics.browserWidth,
          accuracy: 0.5,
          "width \(item.width)"
        )
      }
      if item.inspectorVisible {
        XCTAssertEqual(
          inspector.frame.width,
          StudioWorkspaceSurfaceMetrics.inspectorWidth,
          accuracy: 0.5,
          "width \(item.width)"
        )
      }

      let occupiedSidebarWidth =
        (item.browserVisible ? StudioWorkspaceSurfaceMetrics.browserWidth + 1 : 0)
        + (item.inspectorVisible ? StudioWorkspaceSurfaceMetrics.inspectorWidth + 1 : 0)
      XCTAssertEqual(
        viewer.frame.width,
        item.width - occupiedSidebarWidth,
        accuracy: 0.5,
        "the flexible viewer must receive all non-sidebar width at \(item.width)"
      )
    }
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
