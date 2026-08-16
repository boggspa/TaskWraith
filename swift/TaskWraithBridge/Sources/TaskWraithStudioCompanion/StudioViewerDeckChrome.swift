import AppKit
import TaskWraithStudioCore

/// Compact, semantic controls for the one workspace viewer deck.
///
/// The controls are projections of host-owned route and review state. They do not
/// keep a second route, proposal, or playback authority locally: every action is
/// handed to the owner and the next refresh reads the resulting state back.
@MainActor
final class StudioViewerDeckChrome: NSStackView {
  static let identifier = "studio.workspace.viewer-deck.chrome"

  var onToggleRoute: ((StudioViewerRoute) -> Void)?
  var onSelectReviewVersion: ((StudioReviewVersion) -> Void)?

  private let sourceButton: NSButton
  private let timelineButton: NSButton
  private let currentButton: NSButton
  private let proposedButton: NSButton

  override init(frame frameRect: NSRect) {
    sourceButton = Self.makeButton(
      identifier: "studio.workspace.route.source",
      label: "Source"
    )
    timelineButton = Self.makeButton(
      identifier: "studio.workspace.route.timeline",
      label: "Timeline"
    )
    currentButton = Self.makeButton(
      identifier: "studio.workspace.review-version.current",
      label: "Current"
    )
    proposedButton = Self.makeButton(
      identifier: "studio.workspace.review-version.proposed",
      label: "Proposed"
    )

    super.init(frame: frameRect)

    identifier = NSUserInterfaceItemIdentifier(Self.identifier)
    setAccessibilityElement(true)
    setAccessibilityRole(.group)
    setAccessibilityLabel("Viewer deck controls")
    orientation = .horizontal
    distribution = .fillEqually
    spacing = 4
    edgeInsets = NSEdgeInsets(top: 4, left: 4, bottom: 4, right: 4)
    addArrangedSubview(sourceButton)
    addArrangedSubview(timelineButton)
    addArrangedSubview(currentButton)
    addArrangedSubview(proposedButton)

    sourceButton.target = self
    sourceButton.action = #selector(sourcePressed)
    timelineButton.target = self
    timelineButton.action = #selector(timelinePressed)
    currentButton.target = self
    currentButton.action = #selector(currentPressed)
    proposedButton.target = self
    proposedButton.action = #selector(proposedPressed)
    update(visibleRoutes: [.source], reviewContext: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("StudioViewerDeckChrome is created in code only")
  }

  func button(identifier: String) -> NSButton? {
    arrangedSubviews
      .compactMap { $0 as? NSButton }
      .first { $0.identifier?.rawValue == identifier }
  }

  func update(
    visibleRoutes: Set<StudioViewerRoute>,
    reviewContext: StudioReviewContext?
  ) {
    // Momentary buttons avoid optimistic state changes. Selection is written
    // only here, from the explicit host projection.
    setSelection(sourceButton, selected: visibleRoutes.contains(.source))
    setSelection(timelineButton, selected: visibleRoutes.contains(.review))

    guard let reviewContext else {
      currentButton.isEnabled = false
      proposedButton.isEnabled = false
      setSelection(currentButton, selected: false, unavailable: true)
      setSelection(proposedButton, selected: false, unavailable: true)
      return
    }

    currentButton.isEnabled = true
    proposedButton.isEnabled = true
    setSelection(currentButton, selected: reviewContext.version == .current)
    setSelection(proposedButton, selected: reviewContext.version == .proposed)
  }

  private func setSelection(_ button: NSButton, selected: Bool, unavailable: Bool = false) {
    button.state = selected ? .on : .off
    button.setAccessibilityValue(
      unavailable ? "unavailable" : (selected ? "selected" : "not selected"))
  }

  private static func makeButton(identifier: String, label: String) -> NSButton {
    let button = NSButton(title: label, target: nil, action: nil)
    button.identifier = NSUserInterfaceItemIdentifier(identifier)
    button.setAccessibilityElement(true)
    button.setAccessibilityRole(.button)
    button.setAccessibilityLabel(label)
    button.setButtonType(.momentaryPushIn)
    button.isBordered = false
    button.state = .off
    return button
  }

  @objc private func sourcePressed() {
    onToggleRoute?(.source)
  }

  @objc private func timelinePressed() {
    onToggleRoute?(.review)
  }

  @objc private func currentPressed() {
    onSelectReviewVersion?(.current)
  }

  @objc private func proposedPressed() {
    onSelectReviewVersion?(.proposed)
  }
}
