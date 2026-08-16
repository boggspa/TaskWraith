import Foundation

/// The owner-approved Studio modes change emphasis inside one workspace. They
/// never create a second project, approval ledger, or playback authority.
public enum StudioWorkspaceMode: String, CaseIterable, Equatable, Sendable {
  case edit
  case review
  case color
}

public enum StudioWorkspaceBrowserSection: String, CaseIterable, Equatable, Sendable {
  case media
  case transcripts
  case effects
}

public enum StudioWorkspaceInspectorSection: String, CaseIterable, Equatable, Sendable {
  case clip
  case color
  case audio
  case proposal
}

public enum StudioWorkspaceSidebar: String, CaseIterable, Equatable, Sendable {
  case browser
  case inspector
}

public enum StudioWorkspaceSizeClass: Equatable, Sendable {
  case wide
  case medium
  case narrow
}

public enum StudioWorkspaceUpperPane: Equatable, Sendable {
  case browser
  case viewerDeck
  case inspector
}

public enum StudioWorkspaceLowerPane: Equatable, Sendable {
  case transcript
  case timeline
  case proposalBar
}

public enum StudioWorkspaceTimelineLane: String, CaseIterable, Equatable, Sendable {
  case ghost = "Ghost"
  case video2 = "V2"
  case video1 = "V1"
  case audio1 = "A1"
  case audio2 = "A2"
}

/// The review case remains the production route identifier. In the locked
/// workspace it is labelled Timeline because that route plays the committed
/// sequence or the open Current/Proposed review; it is not another Source.
extension StudioViewerRoute {
  public var workspaceTitle: String {
    switch self {
    case .source: return "Source"
    case .review: return "Timeline"
    }
  }
}

public struct StudioWorkspaceViewport: Equatable, Sendable {
  public let width: Double
  public let height: Double

  public init?(width: Double, height: Double) {
    guard width.isFinite, height.isFinite, width > 0, height > 0 else {
      return nil
    }
    self.width = width
    self.height = height
  }
}

/// Width thresholds are deliberately policy rather than acceptance constants.
/// The hierarchy is locked; the exact breakpoints are adaptable.
public struct StudioWorkspaceLayoutPolicy: Equatable, Sendable {
  public static let standard = StudioWorkspaceLayoutPolicy(
    mediumMinimumWidth: 900,
    wideMinimumWidth: 1_300
  )!

  public let mediumMinimumWidth: Double
  public let wideMinimumWidth: Double

  public init?(mediumMinimumWidth: Double, wideMinimumWidth: Double) {
    guard
      mediumMinimumWidth.isFinite,
      wideMinimumWidth.isFinite,
      mediumMinimumWidth > 0,
      wideMinimumWidth > mediumMinimumWidth
    else {
      return nil
    }
    self.mediumMinimumWidth = mediumMinimumWidth
    self.wideMinimumWidth = wideMinimumWidth
  }

  public func sizeClass(for viewport: StudioWorkspaceViewport) -> StudioWorkspaceSizeClass {
    if viewport.width >= wideMinimumWidth {
      return .wide
    }
    if viewport.width >= mediumMinimumWidth {
      return .medium
    }
    return .narrow
  }
}

public enum StudioWorkspaceViewerPresentation: Equatable, Sendable {
  /// Source and Timeline appear together, but still consume the existing two
  /// route projections and their one shared playback authority.
  case dual
  case single(StudioViewerRoute)
}

/// A transient pointer into host-owned project state. Holding an identifier here
/// does not make the companion the writer of the selected clip or proposal.
public enum StudioWorkspaceSelection: Equatable, Sendable {
  case none
  case clip(id: String)
  case proposal(id: String)
}

/// The inspector never retains content from a selection that does not match its
/// active section or the host's currently active proposal.
public enum StudioWorkspaceInspectorContent: Equatable, Sendable {
  case empty(section: StudioWorkspaceInspectorSection)
  case clip(id: String, section: StudioWorkspaceInspectorSection)
  case proposal(id: String)
}

/// One resolved presentation of the locked hierarchy. This is input to AppKit,
/// not another state authority.
public struct StudioWorkspacePresentationSnapshot: Equatable, Sendable {
  public let primaryWindowCount: Int
  public let upperPaneOrder: [StudioWorkspaceUpperPane]
  public let lowerPaneOrder: [StudioWorkspaceLowerPane]
  public let timelineLanes: [StudioWorkspaceTimelineLane]
  public let exportActionTitle: String

  public let sizeClass: StudioWorkspaceSizeClass
  public let viewerPresentation: StudioWorkspaceViewerPresentation
  public let browserVisible: Bool
  public let inspectorVisible: Bool
  public let browserDrawerAvailable: Bool
  public let inspectorDrawerAvailable: Bool
  public let transcriptVisible: Bool
  public let timelineVisible: Bool
  public let proposalBarVisible: Bool
  public let inspectorContent: StudioWorkspaceInspectorContent

  init(
    sizeClass: StudioWorkspaceSizeClass,
    viewerPresentation: StudioWorkspaceViewerPresentation,
    browserVisible: Bool,
    inspectorVisible: Bool,
    browserDrawerAvailable: Bool,
    inspectorDrawerAvailable: Bool,
    proposalBarVisible: Bool,
    inspectorContent: StudioWorkspaceInspectorContent
  ) {
    primaryWindowCount = 1
    upperPaneOrder = [.browser, .viewerDeck, .inspector]
    lowerPaneOrder = [.transcript, .timeline, .proposalBar]
    timelineLanes = [.ghost, .video2, .video1, .audio1, .audio2]
    exportActionTitle = "Export Timeline…"

    self.sizeClass = sizeClass
    self.viewerPresentation = viewerPresentation
    self.browserVisible = browserVisible
    self.inspectorVisible = inspectorVisible
    self.browserDrawerAvailable = browserDrawerAvailable
    self.inspectorDrawerAvailable = inspectorDrawerAvailable
    transcriptVisible = true
    timelineVisible = true
    self.proposalBarVisible = proposalBarVisible
    self.inspectorContent = inspectorContent
  }
}

/// Transient workspace presentation state.
///
/// Durable assets, proposals, revisions, and approval outcomes remain host
/// owned. Route resource ownership remains in StudioRouteVisibility and the
/// AppKit state; this type only decides how the already-visible routes and
/// current host identities are arranged.
public struct StudioWorkspacePresentationState: Equatable, Sendable {
  public private(set) var mode: StudioWorkspaceMode
  public private(set) var activeRoute: StudioViewerRoute
  public private(set) var browserSection: StudioWorkspaceBrowserSection
  public private(set) var inspectorSection: StudioWorkspaceInspectorSection
  public private(set) var selection: StudioWorkspaceSelection

  private var browserRequested: Bool
  private var inspectorRequested: Bool
  private var compactSidebar: StudioWorkspaceSidebar

  public init(
    mode: StudioWorkspaceMode = .edit,
    activeRoute: StudioViewerRoute = .source,
    browserSection: StudioWorkspaceBrowserSection = .media,
    inspectorSection: StudioWorkspaceInspectorSection = .clip
  ) {
    self.mode = mode
    self.activeRoute = activeRoute
    self.browserSection = browserSection
    self.inspectorSection = inspectorSection
    selection = .none
    browserRequested = true
    inspectorRequested = true
    compactSidebar = .browser
  }

  public mutating func setMode(_ mode: StudioWorkspaceMode) {
    self.mode = mode
  }

  public mutating func setActiveRoute(_ route: StudioViewerRoute) {
    activeRoute = route
  }

  public mutating func setBrowserSection(_ section: StudioWorkspaceBrowserSection) {
    browserSection = section
  }

  public mutating func setInspectorSection(_ section: StudioWorkspaceInspectorSection) {
    inspectorSection = section
  }

  /// At medium sizes only one expanded sidebar is allowed. Asking to show a
  /// sidebar also makes it the compact preference; the wide preference for
  /// the other sidebar remains intact.
  public mutating func setSidebar(_ sidebar: StudioWorkspaceSidebar, visible: Bool) {
    switch sidebar {
    case .browser:
      browserRequested = visible
    case .inspector:
      inspectorRequested = visible
    }
    if visible {
      compactSidebar = sidebar
    } else if compactSidebar == sidebar {
      compactSidebar = sidebar == .browser ? .inspector : .browser
    }
  }

  @discardableResult
  public mutating func selectClip(id: String) -> Bool {
    guard let id = Self.validIdentifier(id) else {
      selection = .none
      return false
    }
    selection = .clip(id: id)
    return true
  }

  @discardableResult
  public mutating func selectProposal(id: String) -> Bool {
    guard let id = Self.validIdentifier(id) else {
      selection = .none
      return false
    }
    selection = .proposal(id: id)
    return true
  }

  public mutating func clearSelection() {
    selection = .none
  }

  public func snapshot(
    viewport: StudioWorkspaceViewport,
    visibleRoutes: Set<StudioViewerRoute>,
    activeProposalId: String?,
    policy: StudioWorkspaceLayoutPolicy = .standard
  ) -> StudioWorkspacePresentationSnapshot {
    let sizeClass = policy.sizeClass(for: viewport)
    let normalizedRoutes = visibleRoutes.isEmpty ? Set([StudioViewerRoute.source]) : visibleRoutes
    let resolvedRoute = resolvedActiveRoute(in: normalizedRoutes)
    let viewerPresentation: StudioWorkspaceViewerPresentation
    if sizeClass == .wide,
      normalizedRoutes.contains(.source),
      normalizedRoutes.contains(.review)
    {
      viewerPresentation = .dual
    } else {
      viewerPresentation = .single(resolvedRoute)
    }

    let sidebarVisibility = resolvedSidebarVisibility(for: sizeClass)
    let validProposalId = activeProposalId.flatMap(Self.validIdentifier)
    return StudioWorkspacePresentationSnapshot(
      sizeClass: sizeClass,
      viewerPresentation: viewerPresentation,
      browserVisible: sidebarVisibility.browser,
      inspectorVisible: sidebarVisibility.inspector,
      browserDrawerAvailable: browserRequested && !sidebarVisibility.browser,
      inspectorDrawerAvailable: inspectorRequested && !sidebarVisibility.inspector,
      proposalBarVisible: validProposalId != nil,
      inspectorContent: resolvedInspectorContent(activeProposalId: validProposalId)
    )
  }

  private func resolvedActiveRoute(
    in visibleRoutes: Set<StudioViewerRoute>
  ) -> StudioViewerRoute {
    if visibleRoutes.contains(activeRoute) {
      return activeRoute
    }
    if visibleRoutes.contains(.source) {
      return .source
    }
    return .review
  }

  private func resolvedSidebarVisibility(
    for sizeClass: StudioWorkspaceSizeClass
  ) -> (browser: Bool, inspector: Bool) {
    switch sizeClass {
    case .wide:
      return (browserRequested, inspectorRequested)
    case .medium:
      switch compactSidebar {
      case .browser where browserRequested:
        return (true, false)
      case .inspector where inspectorRequested:
        return (false, true)
      default:
        if browserRequested {
          return (true, false)
        }
        if inspectorRequested {
          return (false, true)
        }
        return (false, false)
      }
    case .narrow:
      return (false, false)
    }
  }

  private func resolvedInspectorContent(
    activeProposalId: String?
  ) -> StudioWorkspaceInspectorContent {
    switch (inspectorSection, selection) {
    case (.proposal, .proposal(let id)) where id == activeProposalId:
      return .proposal(id: id)
    case (.clip, .clip(let id)), (.color, .clip(let id)), (.audio, .clip(let id)):
      return .clip(id: id, section: inspectorSection)
    default:
      return .empty(section: inspectorSection)
    }
  }

  private static func validIdentifier(_ value: String) -> String? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.utf8.count <= 512 else {
      return nil
    }
    return trimmed
  }
}
