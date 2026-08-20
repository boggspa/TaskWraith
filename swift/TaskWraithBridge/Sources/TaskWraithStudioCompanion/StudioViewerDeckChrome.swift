import AppKit
import TaskWraithStudioCore

/// Compact, semantic controls for the one workspace viewer deck.
///
/// The controls are projections of host-owned route and review state. They do not
/// keep a second route, proposal, or playback authority locally: every action is
/// handed to the owner and the next refresh reads the resulting state back.
private final class StudioHostProjectedButtonCell: NSButtonCell {
  private var preservesProjectedState = false

  override func setButtonType(_ type: NSButton.ButtonType) {
    super.setButtonType(type)
    preservesProjectedState = type == .momentaryPushIn
  }

  override func setNextState() {
    if !preservesProjectedState {
      super.setNextState()
    }
  }

  override func performClick(_ sender: Any?) {
    guard preservesProjectedState else {
      super.performClick(sender)
      return
    }
    guard let control = controlView as? NSControl else { return }
    _ = control.sendAction(control.action, to: control.target)
  }
}

private final class StudioHostProjectedButton: NSButton {
  override func isAccessibilitySelectorAllowed(_ selector: Selector) -> Bool {
    if selector == #selector(accessibilityPerformPress) { return true }
    return super.isAccessibilitySelectorAllowed(selector)
  }

  override func accessibilityPerformPress() -> Bool {
    guard isEnabled else { return false }
    performClick(nil)
    return true
  }
}

@MainActor
final class StudioViewerDeckChrome: NSStackView {
  static let identifier = "studio.workspace.viewer-deck.chrome"

  var onToggleRoute: ((StudioViewerRoute) -> Void)?
  var onSelectReviewVersion: ((StudioReviewVersion) -> Void)?

  private let sourceButton: NSButton
  private let timelineButton: NSButton
  private let currentButton: NSButton
  private let proposedButton: NSButton
  private let routeGroup: NSStackView
  private let reviewGroup: NSStackView
  private let deckTitleLabel: NSTextField

  var deckTitleText: String { deckTitleLabel.stringValue }

  override init(frame frameRect: NSRect) {
    sourceButton = Self.makeButton(
      identifier: "studio.workspace.route.source",
      label: "Source",
      role: .checkBox
    )
    timelineButton = Self.makeButton(
      identifier: "studio.workspace.route.timeline",
      label: "Timeline",
      role: .checkBox
    )
    currentButton = Self.makeButton(
      identifier: "studio.workspace.review-version.current",
      label: "Current",
      role: .radioButton
    )
    proposedButton = Self.makeButton(
      identifier: "studio.workspace.review-version.proposed",
      label: "Proposed",
      role: .radioButton
    )
    routeGroup = NSStackView(views: [sourceButton, timelineButton])
    reviewGroup = NSStackView(views: [currentButton, proposedButton])
    deckTitleLabel = NSTextField(labelWithString: "VIEWER")

    super.init(frame: frameRect)

    identifier = NSUserInterfaceItemIdentifier(Self.identifier)
    setAccessibilityElement(true)
    setAccessibilityRole(.group)
    setAccessibilityLabel("Viewer deck controls")
    orientation = .horizontal
    alignment = .centerY
    distribution = .fill
    spacing = 8
    edgeInsets = NSEdgeInsets(top: 4, left: 8, bottom: 5, right: 8)
    wantsLayer = true
    layer?.backgroundColor = StudioWorkspacePalette.raised.cgColor

    for (group, identifier) in [
      (routeGroup, "studio.workspace.viewer-deck.routes"),
      (reviewGroup, "studio.workspace.viewer-deck.comparison"),
    ] {
      group.identifier = NSUserInterfaceItemIdentifier(identifier)
      group.orientation = .horizontal
      group.alignment = .centerY
      group.distribution = .fill
      group.spacing = 2
      group.edgeInsets = NSEdgeInsets(top: 2, left: 2, bottom: 2, right: 2)
      group.wantsLayer = true
      group.layer?.backgroundColor = StudioWorkspacePalette.canvas.cgColor
      group.layer?.borderColor = StudioWorkspacePalette.divider.cgColor
      group.layer?.borderWidth = 1
      group.layer?.cornerRadius = 6
      group.setContentHuggingPriority(.required, for: .horizontal)
      group.setContentCompressionResistancePriority(.required, for: .horizontal)
    }

    let spacer = NSView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    spacer.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    addArrangedSubview(routeGroup)
    addArrangedSubview(spacer)
    addArrangedSubview(reviewGroup)

    deckTitleLabel.font = NSFont.monospacedSystemFont(ofSize: 9, weight: .semibold)
    deckTitleLabel.textColor = StudioWorkspacePalette.mutedText
    deckTitleLabel.alignment = .center
    deckTitleLabel.setAccessibilityElement(false)
    deckTitleLabel.translatesAutoresizingMaskIntoConstraints = false
    addSubview(deckTitleLabel)

    let divider = NSView()
    divider.wantsLayer = true
    divider.layer?.backgroundColor = StudioWorkspacePalette.divider.cgColor
    divider.translatesAutoresizingMaskIntoConstraints = false
    addSubview(divider)

    NSLayoutConstraint.activate([
      sourceButton.widthAnchor.constraint(equalToConstant: 70),
      timelineButton.widthAnchor.constraint(equalToConstant: 76),
      currentButton.widthAnchor.constraint(equalToConstant: 70),
      proposedButton.widthAnchor.constraint(equalToConstant: 78),
      sourceButton.heightAnchor.constraint(equalToConstant: 24),
      timelineButton.heightAnchor.constraint(equalToConstant: 24),
      currentButton.heightAnchor.constraint(equalToConstant: 24),
      proposedButton.heightAnchor.constraint(equalToConstant: 24),
      deckTitleLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
      deckTitleLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
      divider.leadingAnchor.constraint(equalTo: leadingAnchor),
      divider.trailingAnchor.constraint(equalTo: trailingAnchor),
      divider.bottomAnchor.constraint(equalTo: bottomAnchor),
      divider.heightAnchor.constraint(equalToConstant: 1),
    ])

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
    func find(in view: NSView) -> NSButton? {
      if let button = view as? NSButton,
        button.identifier?.rawValue == identifier
      {
        return button
      }
      for child in view.subviews {
        if let match = find(in: child) { return match }
      }
      return nil
    }
    return find(in: self)
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
    button.alphaValue = 1
    button.layer?.backgroundColor =
      selected
      ? StudioWorkspacePalette.accentSoft.cgColor
      : NSColor.clear.cgColor
    button.layer?.borderColor =
      selected
      ? StudioWorkspacePalette.accent.cgColor
      : NSColor.clear.cgColor
    button.layer?.borderWidth = selected ? 1 : 0
    button.attributedTitle = NSAttributedString(
      string: button.title,
      attributes: [
        .font: NSFont.systemFont(ofSize: 10, weight: selected ? .semibold : .medium),
        .foregroundColor:
          unavailable
          ? StudioWorkspacePalette.mutedText
          : StudioWorkspacePalette.primaryText,
      ]
    )
  }

  private static func makeButton(
    identifier: String,
    label: String,
    role: NSAccessibility.Role
  ) -> NSButton {
    let button = StudioHostProjectedButton(title: label, target: nil, action: nil)
    button.cell = StudioHostProjectedButtonCell(textCell: label)
    button.identifier = NSUserInterfaceItemIdentifier(identifier)
    button.setAccessibilityElement(true)
    button.setButtonType(.momentaryPushIn)
    button.setAccessibilityRole(role)
    button.setAccessibilityLabel(label)
    button.isBordered = false
    button.wantsLayer = true
    button.layer?.cornerRadius = 4
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
