import XCTest

@testable import TaskWraithStudioCore

final class StudioWorkspaceLayoutTests: XCTestCase {
  private let policy = StudioWorkspaceLayoutPolicy(
    mediumMinimumWidth: 900,
    wideMinimumWidth: 1_300
  )!

  func testLockedHierarchyAndLanguageAreLiteral() {
    let state = StudioWorkspacePresentationState()
    let snapshot = state.snapshot(
      viewport: viewport(width: 1_600),
      visibleRoutes: [.source, .review],
      activeProposalId: "proposal-a",
      policy: policy
    )

    XCTAssertEqual(snapshot.primaryWindowCount, 1)
    XCTAssertEqual(snapshot.upperPaneOrder, [.browser, .viewerDeck, .inspector])
    XCTAssertEqual(snapshot.lowerPaneOrder, [.transcript, .timeline, .proposalBar])
    XCTAssertEqual(snapshot.timelineLanes, [.ghost, .video2, .video1, .audio1, .audio2])
    XCTAssertEqual(StudioWorkspaceMode.allCases, [.edit, .review, .color])
    XCTAssertEqual(
      StudioWorkspaceBrowserSection.allCases,
      [.media, .transcripts, .effects]
    )
    XCTAssertEqual(
      StudioWorkspaceInspectorSection.allCases,
      [.clip, .color, .audio, .proposal]
    )
    XCTAssertEqual(snapshot.exportActionTitle, "Export Timeline…")
    XCTAssertEqual(StudioViewerRoute.source.workspaceTitle, "Source")
    XCTAssertEqual(StudioViewerRoute.review.workspaceTitle, "Timeline")
    XCTAssertTrue(snapshot.proposalBarVisible)
  }

  func testResponsivePresentationKeepsOneHierarchyAndPersistentProposal() {
    var state = StudioWorkspacePresentationState()
    state.setActiveRoute(.review)

    let wide = state.snapshot(
      viewport: viewport(width: 1_600),
      visibleRoutes: [.source, .review],
      activeProposalId: "proposal-a",
      policy: policy
    )
    XCTAssertEqual(wide.sizeClass, .wide)
    XCTAssertEqual(wide.viewerPresentation, .dual)
    XCTAssertTrue(wide.browserVisible)
    XCTAssertTrue(wide.inspectorVisible)
    XCTAssertTrue(wide.transcriptVisible)
    XCTAssertTrue(wide.timelineVisible)
    XCTAssertTrue(wide.proposalBarVisible)

    let medium = state.snapshot(
      viewport: viewport(width: 1_000),
      visibleRoutes: [.source, .review],
      activeProposalId: "proposal-a",
      policy: policy
    )
    XCTAssertEqual(medium.sizeClass, .medium)
    XCTAssertEqual(medium.viewerPresentation, .single(.review))
    XCTAssertTrue(medium.browserVisible)
    XCTAssertFalse(medium.inspectorVisible)
    XCTAssertTrue(medium.proposalBarVisible)

    let narrow = state.snapshot(
      viewport: viewport(width: 720),
      visibleRoutes: [.source, .review],
      activeProposalId: "proposal-a",
      policy: policy
    )
    XCTAssertEqual(narrow.sizeClass, .narrow)
    XCTAssertEqual(narrow.viewerPresentation, .single(.review))
    XCTAssertFalse(narrow.browserVisible)
    XCTAssertFalse(narrow.inspectorVisible)
    XCTAssertTrue(narrow.browserDrawerAvailable)
    XCTAssertTrue(narrow.inspectorDrawerAvailable)
    XCTAssertTrue(narrow.proposalBarVisible)

    let noProposal = state.snapshot(
      viewport: viewport(width: 720),
      visibleRoutes: [.source, .review],
      activeProposalId: nil,
      policy: policy
    )
    XCTAssertFalse(noProposal.proposalBarVisible)

    let invalidProposal = state.snapshot(
      viewport: viewport(width: 720),
      visibleRoutes: [.source, .review],
      activeProposalId: String(repeating: "p", count: 513),
      policy: policy
    )
    XCTAssertFalse(invalidProposal.proposalBarVisible)
  }

  func testMediumPresentationShowsOnlyTheRequestedCompactSidebar() {
    var state = StudioWorkspacePresentationState()

    let browserFirst = state.snapshot(
      viewport: viewport(width: 1_000),
      visibleRoutes: [.source],
      activeProposalId: nil,
      policy: policy
    )
    XCTAssertTrue(browserFirst.browserVisible)
    XCTAssertFalse(browserFirst.inspectorVisible)

    state.setSidebar(.inspector, visible: true)
    let inspectorFirst = state.snapshot(
      viewport: viewport(width: 1_000),
      visibleRoutes: [.source],
      activeProposalId: nil,
      policy: policy
    )
    XCTAssertFalse(inspectorFirst.browserVisible)
    XCTAssertTrue(inspectorFirst.inspectorVisible)

    state.setSidebar(.inspector, visible: false)
    let browserRestored = state.snapshot(
      viewport: viewport(width: 1_000),
      visibleRoutes: [.source],
      activeProposalId: nil,
      policy: policy
    )
    XCTAssertTrue(browserRestored.browserVisible)
    XCTAssertFalse(browserRestored.inspectorVisible)

    let wide = state.snapshot(
      viewport: viewport(width: 1_600),
      visibleRoutes: [.source],
      activeProposalId: nil,
      policy: policy
    )
    XCTAssertTrue(wide.browserVisible)
    XCTAssertFalse(wide.inspectorVisible)
  }

  func testCollapsedInspectorDoesNotLoseSelectionOrRetainStaleContent() {
    var state = StudioWorkspacePresentationState()
    XCTAssertTrue(state.selectClip(id: "clip-a"))
    state.setInspectorSection(.color)

    let narrow = state.snapshot(
      viewport: viewport(width: 720),
      visibleRoutes: [.source],
      validClipIds: ["clip-a"],
      activeProposalId: nil,
      policy: policy
    )
    XCTAssertFalse(narrow.inspectorVisible)
    XCTAssertEqual(state.selection, .clip(id: "clip-a"))

    let wide = state.snapshot(
      viewport: viewport(width: 1_600),
      visibleRoutes: [.source],
      validClipIds: ["clip-a"],
      activeProposalId: nil,
      policy: policy
    )
    XCTAssertEqual(wide.inspectorContent, .clip(id: "clip-a", section: .color))

    state.setInspectorSection(.proposal)
    XCTAssertEqual(
      state.snapshot(
        viewport: viewport(width: 1_600),
        visibleRoutes: [.source],
        activeProposalId: "proposal-a",
        policy: policy
      ).inspectorContent,
      .empty(section: .proposal)
    )

    XCTAssertTrue(state.selectProposal(id: "proposal-a"))
    XCTAssertEqual(
      state.snapshot(
        viewport: viewport(width: 1_600),
        visibleRoutes: [.source],
        activeProposalId: "proposal-b",
        policy: policy
      ).inspectorContent,
      .empty(section: .proposal),
      "a resolved or replaced proposal must not leave stale inspector values"
    )
    XCTAssertEqual(
      state.snapshot(
        viewport: viewport(width: 1_600),
        visibleRoutes: [.source],
        activeProposalId: "proposal-a",
        policy: policy
      ).inspectorContent,
      .proposal(id: "proposal-a")
    )
  }

  func testViewerPresentationUsesExistingRoutesWithoutMergingTheirMeaning() {
    var state = StudioWorkspacePresentationState()
    state.setActiveRoute(.review)

    XCTAssertEqual(
      state.snapshot(
        viewport: viewport(width: 1_600),
        visibleRoutes: [.source, .review],
        activeProposalId: nil,
        policy: policy
      ).viewerPresentation,
      .dual
    )
    XCTAssertEqual(
      state.snapshot(
        viewport: viewport(width: 1_000),
        visibleRoutes: [.source, .review],
        activeProposalId: nil,
        policy: policy
      ).viewerPresentation,
      .single(.review)
    )
    XCTAssertEqual(
      state.snapshot(
        viewport: viewport(width: 1_600),
        visibleRoutes: [.source],
        activeProposalId: nil,
        policy: policy
      ).viewerPresentation,
      .single(.source)
    )
    XCTAssertEqual(
      state.snapshot(
        viewport: viewport(width: 1_600),
        visibleRoutes: [],
        activeProposalId: nil,
        policy: policy
      ).viewerPresentation,
      .single(.source)
    )
    XCTAssertEqual(state.activeRoute, .review)
  }

  func testWorkspaceModesChangeEmphasisWithoutReplacingSelectionOrRouteState() {
    var state = StudioWorkspacePresentationState()
    state.setActiveRoute(.review)
    XCTAssertTrue(state.selectClip(id: "clip-a"))
    state.setInspectorSection(.audio)

    state.setMode(.color)

    XCTAssertEqual(state.mode, .color)
    XCTAssertEqual(state.activeRoute, .review)
    XCTAssertEqual(state.selection, .clip(id: "clip-a"))
    XCTAssertEqual(state.inspectorSection, .audio)
    XCTAssertEqual(
      state.snapshot(
        viewport: viewport(width: 1_600),
        visibleRoutes: [.source, .review],
        validClipIds: ["clip-a"],
        activeProposalId: nil,
        policy: policy
      ).inspectorContent,
      .clip(id: "clip-a", section: .audio)
    )
  }

  func testRemovedHostClipFailsInspectorClosed() {
    var state = StudioWorkspacePresentationState()
    XCTAssertTrue(state.selectClip(id: "clip-a"))
    state.setInspectorSection(.color)

    XCTAssertEqual(
      state.snapshot(
        viewport: viewport(width: 1_600),
        visibleRoutes: [.source],
        validClipIds: ["clip-a"],
        activeProposalId: nil,
        policy: policy
      ).inspectorContent,
      .clip(id: "clip-a", section: .color)
    )
    XCTAssertEqual(
      state.snapshot(
        viewport: viewport(width: 1_600),
        visibleRoutes: [.source],
        validClipIds: ["clip-b"],
        activeProposalId: nil,
        policy: policy
      ).inspectorContent,
      .empty(section: .color),
      "a clip removed by a later host revision must not leave stale inspector values"
    )
    XCTAssertEqual(state.selection, .clip(id: "clip-a"))
  }

  func testMixedSelectionIsExplicitAndHostValidated() {
    var state = StudioWorkspacePresentationState()
    state.setInspectorSection(.audio)
    XCTAssertTrue(state.selectClips(ids: ["clip-a", "clip-b"]))
    XCTAssertEqual(state.selection, .mixedClips(ids: ["clip-a", "clip-b"]))

    XCTAssertEqual(
      state.snapshot(
        viewport: viewport(width: 1_600),
        visibleRoutes: [.source],
        validClipIds: ["clip-a", "clip-b"],
        activeProposalId: nil,
        policy: policy
      ).inspectorContent,
      .mixed(section: .audio)
    )
    XCTAssertEqual(
      state.snapshot(
        viewport: viewport(width: 1_600),
        visibleRoutes: [.source],
        validClipIds: ["clip-a"],
        activeProposalId: nil,
        policy: policy
      ).inspectorContent,
      .empty(section: .audio),
      "a partially stale mixed selection must fail closed as one selection"
    )

    state.setInspectorSection(.proposal)
    XCTAssertEqual(
      state.snapshot(
        viewport: viewport(width: 1_600),
        visibleRoutes: [.source],
        validClipIds: ["clip-a", "clip-b"],
        activeProposalId: "proposal-a",
        policy: policy
      ).inspectorContent,
      .empty(section: .proposal)
    )
  }

  func testCollapsedInspectorRevalidatesAfterHostRevisionBeforeExpanding() {
    var state = StudioWorkspacePresentationState()
    XCTAssertTrue(state.selectClip(id: "clip-a"))
    state.setInspectorSection(.clip)

    let collapsed = state.snapshot(
      viewport: viewport(width: 720),
      visibleRoutes: [.source],
      validClipIds: ["clip-a"],
      activeProposalId: nil,
      policy: policy
    )
    XCTAssertFalse(collapsed.inspectorVisible)
    XCTAssertEqual(collapsed.inspectorContent, .clip(id: "clip-a", section: .clip))

    let expandedAfterRevision = state.snapshot(
      viewport: viewport(width: 1_600),
      visibleRoutes: [.source],
      validClipIds: ["clip-b"],
      activeProposalId: nil,
      policy: policy
    )
    XCTAssertTrue(expandedAfterRevision.inspectorVisible)
    XCTAssertEqual(expandedAfterRevision.inspectorContent, .empty(section: .clip))
    XCTAssertEqual(state.selection, .clip(id: "clip-a"))
  }

  func testInvalidDimensionsPoliciesAndSelectionIdentifiersFailClosed() {
    XCTAssertNil(StudioWorkspaceViewport(width: 0, height: 900))
    XCTAssertNil(StudioWorkspaceViewport(width: .infinity, height: 900))
    XCTAssertNil(
      StudioWorkspaceLayoutPolicy(
        mediumMinimumWidth: 1_300,
        wideMinimumWidth: 900
      )
    )

    var state = StudioWorkspacePresentationState()
    XCTAssertTrue(state.selectClip(id: "clip-a"))
    XCTAssertFalse(state.selectClip(id: "   "))
    XCTAssertEqual(state.selection, .none)
    XCTAssertFalse(state.selectClips(ids: ["clip-a"]))
    XCTAssertEqual(state.selection, .none)
    XCTAssertFalse(state.selectClips(ids: ["clip-a", " clip-a "]))
    XCTAssertEqual(state.selection, .none)
    XCTAssertFalse(
      state.selectClips(ids: Set((0...256).map { "clip-\($0)" }))
    )
    XCTAssertEqual(state.selection, .none)
    XCTAssertFalse(state.selectProposal(id: String(repeating: "p", count: 513)))
    XCTAssertEqual(state.selection, .none)
  }

  private func viewport(width: Double) -> StudioWorkspaceViewport {
    StudioWorkspaceViewport(width: width, height: 900)!
  }
}
