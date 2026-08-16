import AppKit
import TaskWraithStudioCore

/// The one native Studio workspace.
///
/// Source and Timeline keep their existing renderers and route-specific media
/// leases, but attach to hosts inside this window rather than owning separate
/// primary windows. The presentation snapshot arranges host-owned identities;
/// it does not own the project, proposal, revision, or playback clock.
@MainActor
final class StudioWorkspaceWindowController: NSObject, NSWindowDelegate {
  let window: NSWindow
  let sourceController: StudioViewerWindowController
  let reviewController: StudioViewerWindowController?

  private let rootStack: NSStackView
  private let upperStack: NSStackView
  private let lowerStack: NSStackView
  private let viewerDeck: NSStackView
  private let browserPane: NSView
  private let inspectorPane: NSView
  private let transcriptPane: NSView
  private let timelinePane: NSView
  private let proposalBarPane: NSView
  private let sourceHost: NSView
  private let reviewHost: NSView

  private var presentationState = StudioWorkspacePresentationState()
  private var visibleRoutes: Set<StudioViewerRoute> = [.source]
  private var activeSequence: StudioTimelineSequence?
  private var activeProposalId: String?
  private var viewport: StudioWorkspaceViewport
  private var hasPresented = false

  private(set) var lastSnapshot: StudioWorkspacePresentationSnapshot

  init(
    sourceRenderer: StudioViewerRenderer,
    reviewRenderer: StudioViewerRenderer?,
    authority: StudioPlaybackAuthority,
    audioPlayer: StudioAudioPlayer? = nil,
    audioSchedulingAuthority: StudioAudioSchedulingAuthority? = nil
  ) {
    let initialViewport = StudioWorkspaceViewport(width: 1_280, height: 800)!
    viewport = initialViewport
    lastSnapshot = presentationState.snapshot(
      viewport: initialViewport,
      visibleRoutes: [.source],
      activeProposalId: nil
    )

    let workspaceWindow = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1_280, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    workspaceWindow.title = "TaskWraith Studio"
    workspaceWindow.isReleasedWhenClosed = false
    window = workspaceWindow

    browserPane = Self.makePane(
      identifier: "studio.workspace.browser",
      accessibilityLabel: "Media browser"
    )
    inspectorPane = Self.makePane(
      identifier: "studio.workspace.inspector",
      accessibilityLabel: "Inspector"
    )
    transcriptPane = Self.makePane(
      identifier: "studio.workspace.transcript",
      accessibilityLabel: "Transcript"
    )
    timelinePane = Self.makePane(
      identifier: "studio.workspace.timeline",
      accessibilityLabel: "Timeline"
    )
    proposalBarPane = Self.makePane(
      identifier: "studio.workspace.proposal-bar",
      accessibilityLabel: "Active proposal"
    )
    let sourceHostView = Self.makeViewerHost(
      identifier: "studio.workspace.viewer.source",
      accessibilityLabel: "Source viewer"
    )
    sourceHost = sourceHostView
    let reviewHostView = Self.makeViewerHost(
      identifier: "studio.workspace.viewer.timeline",
      accessibilityLabel: "Timeline viewer"
    )
    reviewHost = reviewHostView

    viewerDeck = NSStackView(views: [sourceHostView, reviewHostView])
    viewerDeck.identifier = NSUserInterfaceItemIdentifier("studio.workspace.viewer-deck")
    viewerDeck.orientation = .horizontal
    viewerDeck.distribution = .fillEqually
    viewerDeck.spacing = 1

    upperStack = NSStackView(views: [browserPane, viewerDeck, inspectorPane])
    upperStack.orientation = .horizontal
    upperStack.distribution = .fill
    upperStack.spacing = 1

    lowerStack = NSStackView(views: [transcriptPane, timelinePane, proposalBarPane])
    lowerStack.orientation = .vertical
    lowerStack.distribution = .fill
    lowerStack.spacing = 1

    rootStack = NSStackView(views: [upperStack, lowerStack])
    rootStack.identifier = NSUserInterfaceItemIdentifier("studio.workspace.root")
    rootStack.orientation = .vertical
    rootStack.distribution = .fill
    rootStack.spacing = 1
    rootStack.frame = workspaceWindow.contentLayoutRect
    rootStack.autoresizingMask = [.width, .height]
    workspaceWindow.contentView = rootStack

    let sourceController = StudioViewerWindowController(
      renderer: sourceRenderer,
      authority: authority,
      route: .source,
      audioPlayer: audioPlayer,
      audioSchedulingAuthority: audioSchedulingAuthority,
      window: workspaceWindow,
      presentationHost: sourceHostView,
      presentWindow: {}
    )
    self.sourceController = sourceController
    reviewController = reviewRenderer.map {
      StudioViewerWindowController(
        renderer: $0,
        authority: authority,
        route: .review,
        audioPlayer: audioPlayer,
        audioSchedulingAuthority: audioSchedulingAuthority,
        window: workspaceWindow,
        presentationHost: reviewHostView,
        presentWindow: {}
      )
    }

    super.init()
    window.delegate = self
    window.center()
    apply(lastSnapshot)
  }

  var upperPaneIdentifiers: [String] {
    upperStack.arrangedSubviews.compactMap { $0.identifier?.rawValue }
  }

  var lowerPaneIdentifiers: [String] {
    lowerStack.arrangedSubviews.compactMap { $0.identifier?.rawValue }
  }

  var exportActionTitle: String {
    lastSnapshot.exportActionTitle
  }

  func show() {
    hasPresented = true
    refresh()
    // Keep the companion visible and capturable without taking key-window or
    // foreground application ownership from the operator.
    window.orderFrontRegardless()
  }

  func update(
    visibleRoutes: Set<StudioViewerRoute>,
    sequence: StudioTimelineSequence?,
    activeProposalId: String?,
    viewport: StudioWorkspaceViewport? = nil
  ) {
    self.visibleRoutes = normalizedVisibleRoutes(visibleRoutes)
    activeSequence = sequence
    self.activeProposalId = activeProposalId
    if let viewport {
      self.viewport = viewport
    }
    refresh()
  }

  func setActiveRoute(_ route: StudioViewerRoute) {
    let availableRoute: StudioViewerRoute =
      route == .review && reviewController == nil
      ? .source
      : route
    presentationState.setActiveRoute(availableRoute)
    refresh()
  }

  func setInspectorSection(_ section: StudioWorkspaceInspectorSection) {
    presentationState.setInspectorSection(section)
    refresh()
  }

  @discardableResult
  func selectClip(id: String) -> Bool {
    let accepted = presentationState.selectClip(id: id)
    refresh()
    return accepted
  }

  @discardableResult
  func selectProposal(id: String) -> Bool {
    let accepted = presentationState.selectProposal(id: id)
    refresh()
    return accepted
  }

  func routeHostIsVisible(_ route: StudioViewerRoute) -> Bool {
    switch route {
    case .source:
      return !sourceHost.isHidden
    case .review:
      return !reviewHost.isHidden
    }
  }

  func windowWillClose(_ notification: Notification) {
    hasPresented = false
    sourceController.detachPresentation()
    reviewController?.detachPresentation()
  }

  func windowDidResize(_ notification: Notification) {
    guard
      let measured = StudioWorkspaceViewport(
        width: window.contentLayoutRect.width,
        height: window.contentLayoutRect.height
      )
    else { return }
    viewport = measured
    refresh()
  }

  private func normalizedVisibleRoutes(
    _ routes: Set<StudioViewerRoute>
  ) -> Set<StudioViewerRoute> {
    guard reviewController == nil else {
      return routes.isEmpty ? [.source] : routes
    }

    var normalized = routes
    normalized.remove(.review)
    if normalized.isEmpty {
      normalized.insert(.source)
    }
    return normalized
  }

  private func refresh() {
    let validClipIds = Set(activeSequence?.items.map(\.itemId) ?? [])
    lastSnapshot = presentationState.snapshot(
      viewport: viewport,
      visibleRoutes: visibleRoutes,
      validClipIds: validClipIds,
      activeProposalId: activeProposalId
    )
    apply(lastSnapshot)
  }

  private func apply(_ snapshot: StudioWorkspacePresentationSnapshot) {
    browserPane.isHidden = !snapshot.browserVisible
    inspectorPane.isHidden = !snapshot.inspectorVisible
    transcriptPane.isHidden = !snapshot.transcriptVisible
    timelinePane.isHidden = !snapshot.timelineVisible
    proposalBarPane.isHidden = !snapshot.proposalBarVisible

    switch snapshot.viewerPresentation {
    case .dual:
      sourceHost.isHidden = false
      reviewHost.isHidden = reviewController == nil
    case .single(.source):
      sourceHost.isHidden = false
      reviewHost.isHidden = true
    case .single(.review):
      sourceHost.isHidden = true
      reviewHost.isHidden = reviewController == nil
    }

    guard hasPresented else { return }
    if visibleRoutes.contains(.source) {
      sourceController.attachPresentation()
    } else {
      sourceController.detachPresentation()
    }
    if let reviewController {
      if visibleRoutes.contains(.review) {
        reviewController.attachPresentation()
      } else {
        reviewController.detachPresentation()
      }
    }
  }

  private static func makePane(
    identifier: String,
    accessibilityLabel: String
  ) -> NSView {
    let view = NSView()
    view.identifier = NSUserInterfaceItemIdentifier(identifier)
    view.setAccessibilityElement(true)
    view.setAccessibilityRole(.group)
    view.setAccessibilityLabel(accessibilityLabel)
    view.wantsLayer = true
    view.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    return view
  }

  private static func makeViewerHost(
    identifier: String,
    accessibilityLabel: String
  ) -> NSView {
    let view = makePane(identifier: identifier, accessibilityLabel: accessibilityLabel)
    view.layer?.backgroundColor = NSColor.black.cgColor
    return view
  }
}
