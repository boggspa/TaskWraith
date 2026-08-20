import AppKit
import XCTest

@testable import TaskWraithStudioCompanion
@testable import TaskWraithStudioCore

@MainActor
final class StudioWorkspaceSurfaceTests: XCTestCase {
  func testEditorPaletteUsesOpaqueDeterministicSurfaces() {
    for color in [
      StudioWorkspacePalette.canvas,
      StudioWorkspacePalette.panel,
      StudioWorkspacePalette.raised,
      StudioWorkspacePalette.divider,
      StudioWorkspacePalette.primaryText,
      StudioWorkspacePalette.mutedText,
      StudioWorkspacePalette.accent,
    ] {
      XCTAssertEqual(color.alphaComponent, 1, accuracy: 0.001)
    }
    XCTAssertNotEqual(StudioWorkspacePalette.canvas, StudioWorkspacePalette.panel)
    XCTAssertNotEqual(StudioWorkspacePalette.panel, StudioWorkspacePalette.raised)
    XCTAssertNotEqual(StudioWorkspacePalette.accent, NSColor.systemBlue)
  }

  func testToolbarAndHonestPlaceholderCopyAvoidHydrationSentinelText() {
    let toolbar = StudioWorkspaceToolbarView()
    XCTAssertEqual(toolbar.identifier?.rawValue, StudioWorkspaceToolbarView.identifier)
    XCTAssertEqual(toolbar.titleText, "TASKWRAITH STUDIO")
    XCTAssertEqual(toolbar.modeText, "EDIT WORKSPACE")
    XCTAssertEqual(toolbar.statusText, "ONE WORKSPACE  •  HOST OWNED")

    let browser = StudioWorkspaceBrowserSurface()
    XCTAssertEqual(browser.identifier?.rawValue, "studio.workspace.browser")
    XCTAssertEqual(browser.accessoryLabel.stringValue, "LIBRARY")
    XCTAssertFalse(
      "\(browser.emptyStateTitle) \(browser.emptyStateDetail)"
        .localizedCaseInsensitiveContains("no media")
    )

    let transcript = StudioWorkspaceTranscriptRail()
    XCTAssertEqual(transcript.statusText, "Follows Source playback")
  }

  func testInspectorProjectsOnlyTheResolvedHostSelection() throws {
    let inspector = StudioWorkspaceInspectorSurface()
    XCTAssertEqual(inspector.representedContent, .empty(section: .clip))

    inspector.update(content: .clip(id: "clip-a", section: .color))
    XCTAssertEqual(inspector.representedContent, .clip(id: "clip-a", section: .color))
    XCTAssertEqual(inspector.accessoryLabel.stringValue, "COLOR")
    XCTAssertEqual(inspector.selectionTitleText, "clip-a")
    XCTAssertEqual(inspector.selectionDetailText, "Host-owned color controls")

    inspector.update(content: .proposal(id: "proposal-a"))
    XCTAssertEqual(inspector.representedContent, .proposal(id: "proposal-a"))
    XCTAssertEqual(inspector.accessoryLabel.stringValue, "PROPOSAL")
  }

  func testTimelineUsesTheLockedFiveLanesAndHostSequenceIdentities() throws {
    let timeline = StudioWorkspaceTimelineSurface()
    XCTAssertEqual(timeline.laneTitles, ["Ghost", "V2", "V1", "A1", "A2"])
    XCTAssertEqual(timeline.representedItemIds, [])
    XCTAssertEqual(timeline.accessoryLabel.stringValue, "READY")

    let sequence = StudioTimelineSequence(items: [
      StudioSequenceItem(
        itemId: "clip-a",
        assetId: "asset-a",
        startTicks: 0,
        endTicks: 600,
        sourceInTicks: 0
      ),
      StudioSequenceItem(
        itemId: "clip-b",
        assetId: "asset-b",
        startTicks: 600,
        endTicks: 1_200,
        sourceInTicks: 40
      ),
    ])
    timeline.update(sequence: sequence, activeProposalId: "proposal-a")

    XCTAssertEqual(timeline.representedItemIds, ["clip-a", "clip-b"])
    XCTAssertEqual(timeline.representedProposalId, "proposal-a")
    XCTAssertEqual(timeline.accessoryLabel.stringValue, "2 CLIPS")
  }

  func testProposalBarNeverRetainsAResolvedProposalIdentity() {
    let proposal = StudioWorkspaceProposalBar()
    proposal.update(proposalId: "proposal-a")
    XCTAssertEqual(proposal.representedProposalId, "proposal-a")

    proposal.update(proposalId: nil)
    XCTAssertNil(proposal.representedProposalId)
  }
}
