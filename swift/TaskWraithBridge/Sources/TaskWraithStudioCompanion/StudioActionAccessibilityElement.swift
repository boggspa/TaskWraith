import AppKit
import TaskWraithStudioCore

/// A control an assistive client can actually PRESS.
///
/// WHY THIS EXISTS. Review hydrates paused, and every safe route to start it
/// was inert: `CGEventPostToPid` does nothing while the Companion is inactive,
/// and the only alternative is foreground global input — the exact focus theft
/// the acceptance policy forbids. A plain `NSAccessibilityElement` announces a
/// value and accepts no gesture, so the transport was observable and not
/// operable. This exposes AXPress and forwards it to the view's single
/// transport toggle, the same one the Space key runs.
///
/// The value is refreshed IN PLACE from the overlay path, so playback starting
/// or stopping does not reallocate an element every display tick.
final class StudioActionAccessibilityElement: NSAccessibilityElement {
    /// The behaviour a press runs. Returning false means the press was refused,
    /// which an assistive client can report rather than silently swallow.
    nonisolated(unsafe) var performAction: (() -> Bool)?

    /// Identity of the behaviour behind the press. Held so a control can never
    /// be reused in place for a different action — see
    /// StudioAccessibilityDescriptor.matchesStructure.
    nonisolated(unsafe) private(set) var action: StudioAccessibilityAction?

    nonisolated(unsafe) private var displayedLabel = ""
    nonisolated(unsafe) private var displayedValue = ""

    func publish(label: String, value: String, action: StudioAccessibilityAction?) {
        displayedLabel = label
        displayedValue = value
        self.action = action
    }

    override func isAccessibilityElement() -> Bool { true }

    override func accessibilityRole() -> NSAccessibility.Role? { .button }

    override func accessibilityLabel() -> String? { displayedLabel }

    override func accessibilityIdentifier() -> String? { displayedLabel }

    override func accessibilityValue() -> Any? { displayedValue }

    /// The overlay refresh path sets the value on every change. That is a
    /// display update, not an operator gesture, so it must never run the
    /// action — the playhead slider learned this the hard way, where a refresh
    /// through the value selector would have seeked on every tick.
    override func setAccessibilityValue(_ accessibilityValue: Any?) {
        displayedValue = accessibilityValue as? String ?? displayedValue
    }

    /// AppKit consults this before offering AXPress to a client, so without it
    /// the element would advertise a press nothing could reach.
    override func isAccessibilitySelectorAllowed(_ selector: Selector) -> Bool {
        if selector == #selector(accessibilityPerformPress) { return true }
        return super.isAccessibilitySelectorAllowed(selector)
    }

    override func accessibilityPerformPress() -> Bool {
        performAction?() ?? false
    }
}
