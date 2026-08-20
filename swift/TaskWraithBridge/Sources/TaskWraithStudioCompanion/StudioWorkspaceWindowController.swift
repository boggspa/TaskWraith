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

  private let rootStack: StudioWorkspaceRootStack
  private let workspaceStack: NSStackView
  private let upperStack: NSStackView
  private let lowerStack: NSStackView
  private let viewerDeck: NSStackView
  let workspaceToolbar: StudioWorkspaceToolbarView
  let viewerDeckChrome: StudioViewerDeckChrome
  private let browserPane: StudioWorkspaceBrowserSurface
  private let inspectorPane: StudioWorkspaceInspectorSurface
  private let transcriptPane: StudioWorkspaceTranscriptRail
  private let timelinePane: StudioWorkspaceTimelineSurface
  private let proposalBarPane: StudioWorkspaceProposalBar
  private let sourceHost: NSView
  private let reviewHost: NSView

  private var presentationState = StudioWorkspacePresentationState()
  private var visibleRoutes: Set<StudioViewerRoute> = [.source]
  private var activeSequence: StudioTimelineSequence?
  private var activeProposalId: String?
  private var pendingFirstResponderRoute: StudioViewerRoute?
  private var viewport: StudioWorkspaceViewport
  private var hasPresented = false
  private var browserWidthConstraint: NSLayoutConstraint?
  private var inspectorWidthConstraint: NSLayoutConstraint?

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
    workspaceWindow.appearance = NSAppearance(named: .darkAqua)
    workspaceWindow.backgroundColor = StudioWorkspacePalette.canvas
    workspaceWindow.titlebarAppearsTransparent = true
    workspaceWindow.contentMinSize = NSSize(width: 800, height: 620)
    window = workspaceWindow

    workspaceToolbar = StudioWorkspaceToolbarView()
    browserPane = StudioWorkspaceBrowserSurface()
    inspectorPane = StudioWorkspaceInspectorSurface()
    transcriptPane = StudioWorkspaceTranscriptRail()
    timelinePane = StudioWorkspaceTimelineSurface()
    proposalBarPane = StudioWorkspaceProposalBar()
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

    viewerDeckChrome = StudioViewerDeckChrome()
    let routeStack = NSStackView(views: [sourceHostView, reviewHostView])
    routeStack.orientation = .horizontal
    routeStack.distribution = .fillEqually
    routeStack.spacing = 1

    viewerDeck = NSStackView(views: [viewerDeckChrome, routeStack])
    viewerDeck.identifier = NSUserInterfaceItemIdentifier("studio.workspace.viewer-deck")
    viewerDeck.orientation = .vertical
    viewerDeck.alignment = .width
    viewerDeck.distribution = .fill
    viewerDeck.spacing = 1
    viewerDeck.wantsLayer = true
    viewerDeck.layer?.backgroundColor = StudioWorkspacePalette.canvas.cgColor

    upperStack = NSStackView(views: [browserPane, viewerDeck, inspectorPane])
    upperStack.identifier = NSUserInterfaceItemIdentifier("studio.workspace.upper-deck")
    upperStack.orientation = .horizontal
    upperStack.alignment = .height
    upperStack.distribution = .fill
    upperStack.spacing = 1

    lowerStack = NSStackView(views: [transcriptPane, timelinePane, proposalBarPane])
    lowerStack.identifier = NSUserInterfaceItemIdentifier("studio.workspace.lower-deck")
    lowerStack.orientation = .vertical
    lowerStack.alignment = .width
    lowerStack.distribution = .fill
    lowerStack.spacing = 1

    workspaceStack = NSStackView(views: [upperStack, lowerStack])
    workspaceStack.identifier = NSUserInterfaceItemIdentifier("studio.workspace.editor-deck")
    workspaceStack.orientation = .vertical
    workspaceStack.alignment = .width
    workspaceStack.distribution = .fill
    workspaceStack.spacing = 1

    rootStack = StudioWorkspaceRootStack(views: [workspaceToolbar, workspaceStack])
    rootStack.identifier = NSUserInterfaceItemIdentifier("studio.workspace.root")
    rootStack.setAccessibilityElement(true)
    rootStack.setAccessibilityRole(.group)
    rootStack.setAccessibilityLabel("Studio workspace")
    rootStack.orientation = .vertical
    rootStack.alignment = .width
    rootStack.distribution = .fill
    rootStack.spacing = 1
    rootStack.frame = workspaceWindow.contentLayoutRect
    rootStack.autoresizingMask = [.width, .height]
    browserWidthConstraint = browserPane.widthAnchor.constraint(
      equalToConstant: StudioWorkspaceSurfaceMetrics.browserWidth
    )
    inspectorWidthConstraint = inspectorPane.widthAnchor.constraint(
      equalToConstant: StudioWorkspaceSurfaceMetrics.inspectorWidth
    )
    NSLayoutConstraint.activate([
      workspaceToolbar.heightAnchor.constraint(
        equalToConstant: StudioWorkspaceSurfaceMetrics.toolbarHeight
      ),
      workspaceToolbar.widthAnchor.constraint(equalTo: rootStack.widthAnchor),
      workspaceStack.widthAnchor.constraint(equalTo: rootStack.widthAnchor),
      upperStack.widthAnchor.constraint(equalTo: workspaceStack.widthAnchor),
      lowerStack.widthAnchor.constraint(equalTo: workspaceStack.widthAnchor),
      routeStack.widthAnchor.constraint(equalTo: viewerDeck.widthAnchor),
      upperStack.heightAnchor.constraint(
        equalTo: workspaceStack.heightAnchor,
        multiplier: StudioWorkspaceSurfaceMetrics.upperDeckFraction
      ),
      viewerDeck.widthAnchor.constraint(
        greaterThanOrEqualToConstant: StudioWorkspaceSurfaceMetrics.minimumViewerWidth
      ),
      viewerDeckChrome.heightAnchor.constraint(equalToConstant: 34),
      transcriptPane.heightAnchor.constraint(
        equalToConstant: StudioWorkspaceSurfaceMetrics.transcriptHeight
      ),
      proposalBarPane.heightAnchor.constraint(
        equalToConstant: StudioWorkspaceSurfaceMetrics.proposalHeight
      ),
      timelinePane.heightAnchor.constraint(greaterThanOrEqualToConstant: 120),
    ])
    browserPane.setContentHuggingPriority(.init(999), for: .horizontal)
    browserPane.setContentCompressionResistancePriority(.init(999), for: .horizontal)
    inspectorPane.setContentHuggingPriority(.init(999), for: .horizontal)
    inspectorPane.setContentCompressionResistancePriority(.init(999), for: .horizontal)
    viewerDeck.setContentHuggingPriority(.defaultLow, for: .horizontal)
    viewerDeck.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
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
    let sourceZero = StudioRouteResourceSnapshot(
      route: .source,
      activeSourceCount: 0,
      retainedFrameCount: 0,
      capacity: 0,
      surfaceIDs: []
    ).diagnosticsExportText
    let reviewZero = StudioRouteResourceSnapshot(
      route: .review,
      activeSourceCount: 0,
      retainedFrameCount: 0,
      capacity: 0,
      surfaceIDs: []
    ).diagnosticsExportText
    let reviewResourceProvider: () -> String
    if let reviewController {
      reviewResourceProvider = { [weak reviewController] in
        reviewController?.routeResourceDetail ?? reviewZero
      }
    } else {
      reviewResourceProvider = { reviewZero }
    }
    rootStack.setRouteResourceProviders(
      source: { [weak sourceController] in
        sourceController?.routeResourceDetail ?? sourceZero
      },
      review: reviewResourceProvider
    )
    sourceController.onPresentationStateChanged = { [weak self] in
      self?.refreshChrome()
    }
    reviewController?.onPresentationStateChanged = { [weak self] in
      self?.refreshChrome()
    }
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

  func configureChromeActions(
    onToggleRoute: @escaping (StudioViewerRoute) -> Void,
    onSelectReviewVersion: @escaping (StudioReviewVersion) -> Void
  ) {
    viewerDeckChrome.onToggleRoute = onToggleRoute
    viewerDeckChrome.onSelectReviewVersion = onSelectReviewVersion
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
    pendingFirstResponderRoute = availableRoute
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
    pendingFirstResponderRoute = presentationState.activeRoute
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
    refreshChrome()
    apply(lastSnapshot)
  }

  private func refreshChrome() {
    viewerDeckChrome.update(
      visibleRoutes: visibleRoutes,
      reviewContext: reviewController?.activeReviewContext
    )
  }

  private func apply(_ snapshot: StudioWorkspacePresentationSnapshot) {
    inspectorPane.update(content: snapshot.inspectorContent)
    timelinePane.update(sequence: activeSequence, activeProposalId: activeProposalId)
    proposalBarPane.update(proposalId: activeProposalId)
    browserWidthConstraint?.isActive = snapshot.browserVisible
    inspectorWidthConstraint?.isActive = snapshot.inspectorVisible
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

    guard let pendingFirstResponderRoute else { return }
    let focused: Bool
    switch pendingFirstResponderRoute {
    case .source:
      focused = sourceController.focusPresentation()
    case .review:
      focused = reviewController?.focusPresentation() ?? false
    }
    if focused {
      self.pendingFirstResponderRoute = nil
    }
  }

  private static func makeViewerHost(
    identifier: String,
    accessibilityLabel: String
  ) -> NSView {
    let view = NSView()
    view.identifier = NSUserInterfaceItemIdentifier(identifier)
    view.setAccessibilityElement(true)
    view.setAccessibilityIdentifier(identifier)
    view.setAccessibilityRole(.group)
    view.setAccessibilityLabel(accessibilityLabel)
    view.wantsLayer = true
    view.layer?.backgroundColor = NSColor.black.cgColor
    return view
  }
}
