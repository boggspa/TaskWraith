import AppKit
import TaskWraithStudioCore

@MainActor
enum StudioWorkspacePalette {
  static var canvas: NSColor {
    NSColor(srgbRed: 0.063, green: 0.067, blue: 0.078, alpha: 1)
  }

  static var panel: NSColor {
    NSColor(srgbRed: 0.09, green: 0.102, blue: 0.122, alpha: 1)
  }

  static var raised: NSColor {
    NSColor(srgbRed: 0.137, green: 0.153, blue: 0.18, alpha: 1)
  }

  static var divider: NSColor {
    NSColor(srgbRed: 0.204, green: 0.227, blue: 0.263, alpha: 1)
  }

  static var primaryText: NSColor {
    NSColor(srgbRed: 0.906, green: 0.918, blue: 0.933, alpha: 1)
  }

  static var mutedText: NSColor {
    NSColor(srgbRed: 0.608, green: 0.639, blue: 0.678, alpha: 1)
  }

  static var accent: NSColor {
    NSColor(srgbRed: 0.384, green: 0.357, blue: 0.949, alpha: 1)
  }

  static var accentSoft: NSColor {
    NSColor(srgbRed: 0.239, green: 0.224, blue: 0.557, alpha: 1)
  }

}

@MainActor
enum StudioWorkspaceSurfaceMetrics {
  static let toolbarHeight: CGFloat = 40
  static let paneHeaderHeight: CGFloat = 32
  static let browserWidth: CGFloat = 252
  static let inspectorWidth: CGFloat = 284
  static let transcriptHeight: CGFloat = 54
  static let proposalHeight: CGFloat = 44
  static let minimumViewerWidth: CGFloat = 520
  static let upperDeckFraction: CGFloat = 0.6
}

@MainActor
private enum StudioWorkspaceTypography {
  static func label(_ size: CGFloat = 11, weight: NSFont.Weight = .medium) -> NSFont {
    NSFont.systemFont(ofSize: size, weight: weight)
  }

  static func mono(_ size: CGFloat = 10, weight: NSFont.Weight = .medium) -> NSFont {
    NSFont.monospacedSystemFont(ofSize: size, weight: weight)
  }
}

@MainActor
private func studioLabel(
  _ text: String,
  color: NSColor = StudioWorkspacePalette.primaryText,
  font: NSFont = StudioWorkspaceTypography.label()
) -> NSTextField {
  let label = NSTextField(labelWithString: text)
  label.font = font
  label.textColor = color
  label.lineBreakMode = .byTruncatingTail
  label.translatesAutoresizingMaskIntoConstraints = false
  return label
}

@MainActor
private func studioSymbol(_ name: String, pointSize: CGFloat = 13) -> NSImageView {
  let image = NSImage(
    systemSymbolName: name,
    accessibilityDescription: nil
  )?.withSymbolConfiguration(
    NSImage.SymbolConfiguration(pointSize: pointSize, weight: .medium)
  )
  let imageView = NSImageView(image: image ?? NSImage())
  imageView.contentTintColor = StudioWorkspacePalette.mutedText
  imageView.imageScaling = .scaleProportionallyDown
  imageView.translatesAutoresizingMaskIntoConstraints = false
  return imageView
}

/// Accessibility-only resource witnesses for both logical routes.
///
/// They belong to the workspace root rather than either viewer host so hiding
/// a route cannot hide the evidence that its renderer released every resource.
/// The elements are allocated once and appended in Source/Review order on every
/// query; responsive layout changes therefore move neither their identity nor
/// their document order.
@MainActor
private final class StudioWorkspaceRouteResourceAccessibilityElement: NSAccessibilityElement {
  private let elementIdentifier: String
  private let elementLabel: String
  /// AppKit invokes NSAccessibility selectors on its serialized UI path, but
  /// the imported override is not MainActor-annotated. This matches the
  /// Companion's existing action accessibility element: mutation stays on the
  /// main actor; the nonisolated selector reads the installed closure only.
  nonisolated(unsafe) private var valueProvider: () -> String

  init(identifier: String, label: String, valueProvider: @escaping () -> String) {
    elementIdentifier = identifier
    elementLabel = label
    self.valueProvider = valueProvider
    super.init()
  }

  func setValueProvider(_ provider: @escaping () -> String) {
    valueProvider = provider
  }

  override func isAccessibilityElement() -> Bool { true }
  override func accessibilityIdentifier() -> String? { elementIdentifier }
  override func accessibilityRole() -> NSAccessibility.Role? { .staticText }
  override func accessibilityLabel() -> String? { elementLabel }
  override func accessibilityValue() -> Any? { valueProvider() }
}

@MainActor
final class StudioWorkspaceRootStack: NSStackView {
  static let sourceRouteResourceIdentifier = "studio.workspace.resource.source"
  static let reviewRouteResourceIdentifier = "studio.workspace.resource.review"

  private static let sourceZero = StudioRouteResourceSnapshot(
    route: .source,
    activeSourceCount: 0,
    retainedFrameCount: 0,
    capacity: 0,
    surfaceIDs: []
  ).diagnosticsExportText
  private static let reviewZero = StudioRouteResourceSnapshot(
    route: .review,
    activeSourceCount: 0,
    retainedFrameCount: 0,
    capacity: 0,
    surfaceIDs: []
  ).diagnosticsExportText

  private let sourceResourceElement = StudioWorkspaceRouteResourceAccessibilityElement(
    identifier: StudioWorkspaceRootStack.sourceRouteResourceIdentifier,
    label: "Source route resource detail",
    valueProvider: { StudioWorkspaceRootStack.sourceZero }
  )
  private let reviewResourceElement = StudioWorkspaceRouteResourceAccessibilityElement(
    identifier: StudioWorkspaceRootStack.reviewRouteResourceIdentifier,
    label: "Review route resource detail",
    valueProvider: { StudioWorkspaceRootStack.reviewZero }
  )

  func setRouteResourceProviders(
    source: @escaping () -> String,
    review: @escaping () -> String
  ) {
    sourceResourceElement.setValueProvider(source)
    reviewResourceElement.setValueProvider(review)
  }

  override func accessibilityChildren() -> [Any]? {
    sourceResourceElement.setAccessibilityParent(self)
    reviewResourceElement.setAccessibilityParent(self)
    return (super.accessibilityChildren() ?? [])
      + [sourceResourceElement, reviewResourceElement]
  }
}

@MainActor
final class StudioWorkspaceToolbarView: NSView {
  static let identifier = "studio.workspace.toolbar"

  let titleText = "TASKWRAITH STUDIO"
  let modeText = "EDIT WORKSPACE"
  let statusText = "ONE WORKSPACE  •  HOST OWNED"

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)

    identifier = NSUserInterfaceItemIdentifier(Self.identifier)
    setAccessibilityElement(true)
    setAccessibilityIdentifier(Self.identifier)
    setAccessibilityRole(.group)
    setAccessibilityLabel("Studio toolbar")
    wantsLayer = true
    layer?.backgroundColor = StudioWorkspacePalette.raised.cgColor

    let mark = studioSymbol("wand.and.stars", pointSize: 14)
    mark.contentTintColor = StudioWorkspacePalette.accent
    let title = studioLabel(
      titleText,
      font: StudioWorkspaceTypography.label(11, weight: .semibold)
    )
    let leading = NSStackView(views: [mark, title])
    leading.orientation = .horizontal
    leading.alignment = .centerY
    leading.spacing = 7
    leading.translatesAutoresizingMaskIntoConstraints = false

    let mode = studioLabel(
      modeText,
      color: StudioWorkspacePalette.primaryText,
      font: StudioWorkspaceTypography.mono(10, weight: .semibold)
    )
    mode.alignment = .center
    mode.wantsLayer = true
    mode.layer?.backgroundColor = StudioWorkspacePalette.accentSoft.cgColor
    mode.layer?.cornerRadius = 5
    mode.translatesAutoresizingMaskIntoConstraints = false

    let status = studioLabel(
      statusText,
      color: StudioWorkspacePalette.mutedText,
      font: StudioWorkspaceTypography.mono(9)
    )
    status.alignment = .right

    let divider = NSView()
    divider.wantsLayer = true
    divider.layer?.backgroundColor = StudioWorkspacePalette.divider.cgColor
    divider.translatesAutoresizingMaskIntoConstraints = false

    addSubview(leading)
    addSubview(mode)
    addSubview(status)
    addSubview(divider)

    NSLayoutConstraint.activate([
      mark.widthAnchor.constraint(equalToConstant: 16),
      mark.heightAnchor.constraint(equalToConstant: 16),
      leading.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
      leading.centerYAnchor.constraint(equalTo: centerYAnchor),
      mode.centerXAnchor.constraint(equalTo: centerXAnchor),
      mode.centerYAnchor.constraint(equalTo: centerYAnchor),
      mode.widthAnchor.constraint(equalToConstant: 116),
      mode.heightAnchor.constraint(equalToConstant: 24),
      status.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      status.centerYAnchor.constraint(equalTo: centerYAnchor),
      divider.leadingAnchor.constraint(equalTo: leadingAnchor),
      divider.trailingAnchor.constraint(equalTo: trailingAnchor),
      divider.bottomAnchor.constraint(equalTo: bottomAnchor),
      divider.heightAnchor.constraint(equalToConstant: 1),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("StudioWorkspaceToolbarView is created in code only")
  }
}

@MainActor
class StudioWorkspacePaneSurface: NSView {
  let bodyView = NSView()
  let titleLabel: NSTextField
  let accessoryLabel: NSTextField

  init(identifier: String, accessibilityLabel: String, title: String, symbol: String) {
    titleLabel = studioLabel(
      title.uppercased(),
      font: StudioWorkspaceTypography.label(10, weight: .semibold)
    )
    accessoryLabel = studioLabel(
      "",
      color: StudioWorkspacePalette.mutedText,
      font: StudioWorkspaceTypography.mono(9)
    )
    super.init(frame: .zero)

    self.identifier = NSUserInterfaceItemIdentifier(identifier)
    setAccessibilityElement(true)
    setAccessibilityIdentifier(identifier)
    setAccessibilityRole(.group)
    setAccessibilityLabel(accessibilityLabel)
    wantsLayer = true
    layer?.backgroundColor = StudioWorkspacePalette.panel.cgColor

    let icon = studioSymbol(symbol, pointSize: 11)
    let header = NSView()
    header.wantsLayer = true
    header.layer?.backgroundColor = StudioWorkspacePalette.raised.cgColor
    header.translatesAutoresizingMaskIntoConstraints = false

    let divider = NSView()
    divider.wantsLayer = true
    divider.layer?.backgroundColor = StudioWorkspacePalette.divider.cgColor
    divider.translatesAutoresizingMaskIntoConstraints = false

    bodyView.wantsLayer = true
    bodyView.layer?.backgroundColor = StudioWorkspacePalette.panel.cgColor
    bodyView.translatesAutoresizingMaskIntoConstraints = false

    header.addSubview(icon)
    header.addSubview(titleLabel)
    header.addSubview(accessoryLabel)
    addSubview(header)
    addSubview(bodyView)
    addSubview(divider)

    NSLayoutConstraint.activate([
      header.leadingAnchor.constraint(equalTo: leadingAnchor),
      header.trailingAnchor.constraint(equalTo: trailingAnchor),
      header.topAnchor.constraint(equalTo: topAnchor),
      header.heightAnchor.constraint(
        equalToConstant: StudioWorkspaceSurfaceMetrics.paneHeaderHeight
      ),
      icon.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 10),
      icon.centerYAnchor.constraint(equalTo: header.centerYAnchor),
      icon.widthAnchor.constraint(equalToConstant: 13),
      icon.heightAnchor.constraint(equalToConstant: 13),
      titleLabel.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 7),
      titleLabel.centerYAnchor.constraint(equalTo: header.centerYAnchor),
      accessoryLabel.leadingAnchor.constraint(
        greaterThanOrEqualTo: titleLabel.trailingAnchor,
        constant: 8
      ),
      accessoryLabel.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -10),
      accessoryLabel.centerYAnchor.constraint(equalTo: header.centerYAnchor),
      divider.leadingAnchor.constraint(equalTo: leadingAnchor),
      divider.trailingAnchor.constraint(equalTo: trailingAnchor),
      divider.topAnchor.constraint(equalTo: header.bottomAnchor),
      divider.heightAnchor.constraint(equalToConstant: 1),
      bodyView.leadingAnchor.constraint(equalTo: leadingAnchor),
      bodyView.trailingAnchor.constraint(equalTo: trailingAnchor),
      bodyView.topAnchor.constraint(equalTo: divider.bottomAnchor),
      bodyView.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("StudioWorkspacePaneSurface is created in code only")
  }

  func setAccessory(_ text: String) {
    accessoryLabel.stringValue = text
  }
}

@MainActor
private final class StudioWorkspaceInfoCard: NSView {
  init(symbol: String, title: String, detail: String) {
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = StudioWorkspacePalette.raised.cgColor
    layer?.borderColor = StudioWorkspacePalette.divider.cgColor
    layer?.borderWidth = 1
    layer?.cornerRadius = 7
    translatesAutoresizingMaskIntoConstraints = false

    let icon = studioSymbol(symbol, pointSize: 18)
    icon.contentTintColor = StudioWorkspacePalette.accent
    let titleLabel = studioLabel(
      title,
      font: StudioWorkspaceTypography.label(11, weight: .semibold)
    )
    let detailLabel = studioLabel(
      detail,
      color: StudioWorkspacePalette.mutedText,
      font: StudioWorkspaceTypography.label(10)
    )
    detailLabel.maximumNumberOfLines = 2
    detailLabel.lineBreakMode = .byWordWrapping

    let labels = NSStackView(views: [titleLabel, detailLabel])
    labels.orientation = .vertical
    labels.alignment = .leading
    labels.spacing = 3
    labels.translatesAutoresizingMaskIntoConstraints = false

    addSubview(icon)
    addSubview(labels)
    NSLayoutConstraint.activate([
      icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
      icon.topAnchor.constraint(equalTo: topAnchor, constant: 13),
      icon.widthAnchor.constraint(equalToConstant: 22),
      icon.heightAnchor.constraint(equalToConstant: 22),
      labels.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 10),
      labels.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
      labels.topAnchor.constraint(equalTo: topAnchor, constant: 10),
      labels.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("StudioWorkspaceInfoCard is created in code only")
  }
}

@MainActor
final class StudioWorkspaceBrowserSurface: StudioWorkspacePaneSurface {
  let emptyStateTitle = "HOST MEDIA"
  let emptyStateDetail = "Assets and transcripts remain owned by TaskWraith"

  init() {
    super.init(
      identifier: "studio.workspace.browser",
      accessibilityLabel: "Media browser",
      title: "Media",
      symbol: "rectangle.stack"
    )
    setAccessory("LIBRARY")

    let section = studioLabel(
      "CONNECTED SOURCES",
      color: StudioWorkspacePalette.mutedText,
      font: StudioWorkspaceTypography.mono(9, weight: .semibold)
    )
    let card = StudioWorkspaceInfoCard(
      symbol: "link",
      title: emptyStateTitle,
      detail: emptyStateDetail
    )
    bodyView.addSubview(section)
    bodyView.addSubview(card)
    NSLayoutConstraint.activate([
      section.leadingAnchor.constraint(equalTo: bodyView.leadingAnchor, constant: 12),
      section.trailingAnchor.constraint(equalTo: bodyView.trailingAnchor, constant: -12),
      section.topAnchor.constraint(equalTo: bodyView.topAnchor, constant: 14),
      card.leadingAnchor.constraint(equalTo: bodyView.leadingAnchor, constant: 10),
      card.trailingAnchor.constraint(equalTo: bodyView.trailingAnchor, constant: -10),
      card.topAnchor.constraint(equalTo: section.bottomAnchor, constant: 9),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("StudioWorkspaceBrowserSurface is created in code only")
  }
}

@MainActor
final class StudioWorkspaceInspectorSurface: StudioWorkspacePaneSurface {
  private let selectionTitle = studioLabel(
    "NOTHING SELECTED",
    font: StudioWorkspaceTypography.label(12, weight: .semibold)
  )
  private let selectionDetail = studioLabel(
    "Select a clip or proposal",
    color: StudioWorkspacePalette.mutedText,
    font: StudioWorkspaceTypography.label(10)
  )

  private(set) var representedContent: StudioWorkspaceInspectorContent = .empty(section: .clip)
  var selectionTitleText: String { selectionTitle.stringValue }
  var selectionDetailText: String { selectionDetail.stringValue }

  init() {
    super.init(
      identifier: "studio.workspace.inspector",
      accessibilityLabel: "Inspector",
      title: "Inspector",
      symbol: "slider.horizontal.3"
    )
    setAccessory("CLIP")

    let icon = studioSymbol("sidebar.right", pointSize: 20)
    icon.contentTintColor = StudioWorkspacePalette.mutedText
    let stack = NSStackView(views: [icon, selectionTitle, selectionDetail])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 7
    stack.translatesAutoresizingMaskIntoConstraints = false
    bodyView.addSubview(stack)
    NSLayoutConstraint.activate([
      icon.widthAnchor.constraint(equalToConstant: 24),
      icon.heightAnchor.constraint(equalToConstant: 24),
      stack.centerXAnchor.constraint(equalTo: bodyView.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: bodyView.centerYAnchor),
      stack.leadingAnchor.constraint(greaterThanOrEqualTo: bodyView.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(lessThanOrEqualTo: bodyView.trailingAnchor, constant: -16),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("StudioWorkspaceInspectorSurface is created in code only")
  }

  func update(content: StudioWorkspaceInspectorContent) {
    representedContent = content
    switch content {
    case .empty(let section):
      setAccessory(section.rawValue.uppercased())
      selectionTitle.stringValue = "NOTHING SELECTED"
      selectionDetail.stringValue = "Select a clip or proposal"
    case .clip(let id, let section):
      setAccessory(section.rawValue.uppercased())
      selectionTitle.stringValue = id
      selectionDetail.stringValue = "Host-owned " + section.rawValue + " controls"
    case .mixed(let section):
      setAccessory(section.rawValue.uppercased())
      selectionTitle.stringValue = "MULTIPLE CLIPS"
      selectionDetail.stringValue = "Mixed host-owned values"
    case .proposal(let id):
      setAccessory("PROPOSAL")
      selectionTitle.stringValue = id
      selectionDetail.stringValue = "Active review proposal"
    }
  }
}

@MainActor
final class StudioWorkspaceTranscriptRail: NSView {
  let statusText = "Follows Source playback"

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    identifier = NSUserInterfaceItemIdentifier("studio.workspace.transcript")
    setAccessibilityElement(true)
    setAccessibilityIdentifier("studio.workspace.transcript")
    setAccessibilityRole(.group)
    setAccessibilityLabel("Transcript")
    wantsLayer = true
    layer?.backgroundColor = StudioWorkspacePalette.raised.cgColor

    let icon = studioSymbol("text.quote", pointSize: 13)
    icon.contentTintColor = StudioWorkspacePalette.accent
    let title = studioLabel(
      "TRANSCRIPT",
      font: StudioWorkspaceTypography.label(10, weight: .semibold)
    )
    let status = studioLabel(
      statusText,
      color: StudioWorkspacePalette.mutedText,
      font: StudioWorkspaceTypography.label(10)
    )
    let ownership = studioLabel(
      "HOST OWNED",
      color: StudioWorkspacePalette.mutedText,
      font: StudioWorkspaceTypography.mono(9, weight: .semibold)
    )
    ownership.alignment = .right

    let divider = NSView()
    divider.wantsLayer = true
    divider.layer?.backgroundColor = StudioWorkspacePalette.divider.cgColor
    divider.translatesAutoresizingMaskIntoConstraints = false

    for view in [icon, title, status, ownership, divider] {
      addSubview(view)
    }
    NSLayoutConstraint.activate([
      icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
      icon.centerYAnchor.constraint(equalTo: centerYAnchor),
      icon.widthAnchor.constraint(equalToConstant: 16),
      icon.heightAnchor.constraint(equalToConstant: 16),
      title.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 7),
      title.centerYAnchor.constraint(equalTo: centerYAnchor),
      status.leadingAnchor.constraint(equalTo: title.trailingAnchor, constant: 18),
      status.centerYAnchor.constraint(equalTo: centerYAnchor),
      ownership.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      ownership.centerYAnchor.constraint(equalTo: centerYAnchor),
      divider.leadingAnchor.constraint(equalTo: leadingAnchor),
      divider.trailingAnchor.constraint(equalTo: trailingAnchor),
      divider.bottomAnchor.constraint(equalTo: bottomAnchor),
      divider.heightAnchor.constraint(equalToConstant: 1),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("StudioWorkspaceTranscriptRail is created in code only")
  }
}

@MainActor
final class StudioWorkspaceProposalBar: NSView {
  private let valueLabel = studioLabel(
    "",
    color: StudioWorkspacePalette.primaryText,
    font: StudioWorkspaceTypography.mono(10, weight: .semibold)
  )

  private(set) var representedProposalId: String?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    identifier = NSUserInterfaceItemIdentifier("studio.workspace.proposal-bar")
    setAccessibilityElement(true)
    setAccessibilityIdentifier("studio.workspace.proposal-bar")
    setAccessibilityRole(.group)
    setAccessibilityLabel("Active proposal")
    wantsLayer = true
    layer?.backgroundColor = StudioWorkspacePalette.raised.cgColor

    let accent = NSView()
    accent.wantsLayer = true
    accent.layer?.backgroundColor = StudioWorkspacePalette.accent.cgColor
    accent.translatesAutoresizingMaskIntoConstraints = false
    let title = studioLabel(
      "ACTIVE PROPOSAL",
      color: StudioWorkspacePalette.mutedText,
      font: StudioWorkspaceTypography.mono(9, weight: .semibold)
    )

    addSubview(accent)
    addSubview(title)
    addSubview(valueLabel)
    NSLayoutConstraint.activate([
      accent.leadingAnchor.constraint(equalTo: leadingAnchor),
      accent.topAnchor.constraint(equalTo: topAnchor),
      accent.bottomAnchor.constraint(equalTo: bottomAnchor),
      accent.widthAnchor.constraint(equalToConstant: 3),
      title.leadingAnchor.constraint(equalTo: accent.trailingAnchor, constant: 11),
      title.centerYAnchor.constraint(equalTo: centerYAnchor),
      valueLabel.leadingAnchor.constraint(equalTo: title.trailingAnchor, constant: 14),
      valueLabel.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -12),
      valueLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("StudioWorkspaceProposalBar is created in code only")
  }

  func update(proposalId: String?) {
    representedProposalId = proposalId
    valueLabel.stringValue = proposalId ?? ""
  }
}

@MainActor
private final class StudioWorkspaceTimelineCanvas: NSView {
  static let laneTitles = StudioWorkspaceTimelineLane.allCases.map(\.rawValue)

  var sequenceItems: [StudioSequenceItem] = [] {
    didSet { needsDisplay = true }
  }

  override var isFlipped: Bool { true }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.backgroundColor = StudioWorkspacePalette.canvas.cgColor
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("StudioWorkspaceTimelineCanvas is created in code only")
  }

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    StudioWorkspacePalette.canvas.setFill()
    bounds.fill()

    let railWidth: CGFloat = 58
    let rulerHeight: CGFloat = 24
    let laneCount = CGFloat(Self.laneTitles.count)
    let laneHeight = max(1, (bounds.height - rulerHeight) / laneCount)
    let trackMinX = railWidth
    let trackWidth = max(1, bounds.width - railWidth)

    StudioWorkspacePalette.raised.setFill()
    NSRect(x: 0, y: 0, width: bounds.width, height: rulerHeight).fill()
    NSRect(x: 0, y: rulerHeight, width: railWidth, height: bounds.height - rulerHeight).fill()

    let laneAttributes: [NSAttributedString.Key: Any] = [
      .font: StudioWorkspaceTypography.mono(9, weight: .semibold),
      .foregroundColor: StudioWorkspacePalette.mutedText,
    ]
    for (index, title) in Self.laneTitles.enumerated() {
      let laneY = rulerHeight + CGFloat(index) * laneHeight
      StudioWorkspacePalette.divider.setStroke()
      let line = NSBezierPath()
      line.move(to: NSPoint(x: 0, y: laneY))
      line.line(to: NSPoint(x: bounds.width, y: laneY))
      line.lineWidth = 1
      line.stroke()
      (title as NSString).draw(
        in: NSRect(x: 10, y: laneY + max(2, (laneHeight - 12) / 2), width: 40, height: 14),
        withAttributes: laneAttributes
      )
    }

    for division in 0...10 {
      let x = trackMinX + CGFloat(division) * trackWidth / 10
      let line = NSBezierPath()
      line.move(to: NSPoint(x: x, y: 0))
      line.line(to: NSPoint(x: x, y: bounds.height))
      line.lineWidth = division == 0 ? 1 : 0.5
      StudioWorkspacePalette.divider.withAlphaComponent(division == 0 ? 1 : 0.45).setStroke()
      line.stroke()
    }

    let rulerAttributes: [NSAttributedString.Key: Any] = [
      .font: StudioWorkspaceTypography.mono(8),
      .foregroundColor: StudioWorkspacePalette.mutedText,
    ]
    for division in stride(from: 0, through: 10, by: 2) {
      let label = String(format: "%02d", division)
      let x = trackMinX + CGFloat(division) * trackWidth / 10 + 4
      (label as NSString).draw(
        in: NSRect(x: x, y: 6, width: 24, height: 12),
        withAttributes: rulerAttributes
      )
    }

    if sequenceItems.isEmpty {
      let emptyAttributes: [NSAttributedString.Key: Any] = [
        .font: StudioWorkspaceTypography.label(10, weight: .medium),
        .foregroundColor: StudioWorkspacePalette.mutedText,
      ]
      let text = "SEQUENCE READY"
      let size = (text as NSString).size(withAttributes: emptyAttributes)
      (text as NSString).draw(
        at: NSPoint(
          x: trackMinX + max(0, (trackWidth - size.width) / 2),
          y: rulerHeight + max(0, (bounds.height - rulerHeight - size.height) / 2)
        ),
        withAttributes: emptyAttributes
      )
      return
    }

    let maximumEnd = max(1, sequenceItems.map(\.endTicks).max() ?? 1)
    let usableTrackWidth = max(1, trackWidth - 16)
    for item in sequenceItems {
      let startFraction = CGFloat(max(0, item.startTicks)) / CGFloat(maximumEnd)
      let endFraction = CGFloat(max(item.startTicks, item.endTicks)) / CGFloat(maximumEnd)
      let clipX = trackMinX + 8 + startFraction * usableTrackWidth
      let clipWidth = max(24, (endFraction - startFraction) * usableTrackWidth - 2)
      let videoRect = NSRect(
        x: clipX,
        y: rulerHeight + laneHeight * 2 + 4,
        width: min(clipWidth, trackMinX + trackWidth - clipX - 8),
        height: max(8, laneHeight - 8)
      )
      StudioWorkspacePalette.accent.withAlphaComponent(0.72).setFill()
      NSBezierPath(roundedRect: videoRect, xRadius: 4, yRadius: 4).fill()
      StudioWorkspacePalette.primaryText.withAlphaComponent(0.25).setStroke()
      NSBezierPath(roundedRect: videoRect, xRadius: 4, yRadius: 4).stroke()
      drawClipLabel(item.itemId, in: videoRect)
    }
  }

  private func drawClipLabel(_ label: String, in rect: NSRect) {
    guard rect.width >= 28 else { return }
    let attributes: [NSAttributedString.Key: Any] = [
      .font: StudioWorkspaceTypography.label(9, weight: .medium),
      .foregroundColor: StudioWorkspacePalette.primaryText,
    ]
    (label as NSString).draw(
      in: rect.insetBy(dx: 6, dy: max(2, (rect.height - 12) / 2)),
      withAttributes: attributes
    )
  }

}

@MainActor
final class StudioWorkspaceTimelineSurface: StudioWorkspacePaneSurface {
  private let canvas = StudioWorkspaceTimelineCanvas()

  var laneTitles: [String] { StudioWorkspaceTimelineCanvas.laneTitles }
  private(set) var representedItemIds: [String] = []
  private(set) var representedProposalId: String?

  init() {
    super.init(
      identifier: "studio.workspace.timeline",
      accessibilityLabel: "Timeline",
      title: "Timeline",
      symbol: "timeline.selection"
    )
    setAccessory("READY")
    canvas.translatesAutoresizingMaskIntoConstraints = false
    bodyView.addSubview(canvas)
    NSLayoutConstraint.activate([
      canvas.leadingAnchor.constraint(equalTo: bodyView.leadingAnchor),
      canvas.trailingAnchor.constraint(equalTo: bodyView.trailingAnchor),
      canvas.topAnchor.constraint(equalTo: bodyView.topAnchor),
      canvas.bottomAnchor.constraint(equalTo: bodyView.bottomAnchor),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("StudioWorkspaceTimelineSurface is created in code only")
  }

  func update(sequence: StudioTimelineSequence?, activeProposalId: String?) {
    let items = sequence?.items ?? []
    representedItemIds = items.map(\.itemId)
    representedProposalId = activeProposalId
    canvas.sequenceItems = items
    if items.isEmpty {
      setAccessory(activeProposalId == nil ? "READY" : "1 PROPOSAL")
    } else {
      setAccessory("\(items.count) \(items.count == 1 ? "CLIP" : "CLIPS")")
    }
  }
}
