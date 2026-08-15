import AppKit
import TaskWraithStudioCore

/// The Playhead slider an assistive client actually operates.
///
/// A plain `NSAccessibilityElement` can announce a value and cannot accept one.
/// VoiceOver users therefore could hear the playhead and could not scrub it.
/// This element keeps the spoken timecode as the value description, exposes a
/// numeric tick slider, and forwards every set/increment to the existing
/// `StudioTransportController` through `StudioPlayheadAccessibilityBinding`.
///
/// Displayed ticks are published from the overlay refresh path. That path must
/// NOT call `setAccessibilityValue`, because that selector is the operator
/// gesture and would seek on every display-link tick.
///
/// AppKit and AX clients set values through the attribute/action informal
/// protocol, not only the Swift `setAccessibilityValue` convenience. Both
/// paths land here so VoiceOver and a typed test call do the same thing.
final class StudioPlayheadAccessibilityElement: NSAccessibilityElement {
    nonisolated(unsafe) var applyValue: ((StudioPlayheadAccessibilityValue) -> Bool)?
    nonisolated(unsafe) var applyStep: ((Int64) -> Bool)?

    nonisolated(unsafe) private var displayedTicks: Int64 = 0
    nonisolated(unsafe) private var displayedDurationTicks: Int64 = 0
    nonisolated(unsafe) private var displayedSpoken = ""

    func publish(ticks: Int64, durationTicks: Int64, spoken: String) {
        displayedTicks = ticks
        displayedDurationTicks = durationTicks
        displayedSpoken = spoken
    }

    @discardableResult
    func apply(_ raw: Any?) -> Bool {
        guard let parsed = StudioPlayheadAccessibilityValue.parse(raw) else { return false }
        return applyValue?(parsed) ?? false
    }

    override func isAccessibilityElement() -> Bool { true }

    override func accessibilityRole() -> NSAccessibility.Role? { .slider }

    override func accessibilityLabel() -> String? { "Playhead" }

    override func accessibilityIdentifier() -> String? { "Playhead" }

    override func accessibilityValue() -> Any? { NSNumber(value: displayedTicks) }

    override func accessibilityMinValue() -> Any? { NSNumber(value: 0) }

    override func accessibilityMaxValue() -> Any? { NSNumber(value: displayedDurationTicks) }

    override func accessibilityValueDescription() -> String? { displayedSpoken }

    override func accessibilityOrientation() -> NSAccessibilityOrientation { .horizontal }

    override func setAccessibilityValue(_ accessibilityValue: Any?) {
        _ = apply(accessibilityValue)
    }

    override func accessibilityPerformIncrement() -> Bool {
        applyStep?(1) ?? false
    }

    override func accessibilityPerformDecrement() -> Bool {
        applyStep?(-1) ?? false
    }

    override func accessibilityIsAttributeSettable(_ attribute: NSAccessibility.Attribute) -> Bool {
        if attribute == .value { return true }
        return super.accessibilityIsAttributeSettable(attribute)
    }

    override func accessibilitySetValue(_ value: Any?, forAttribute attribute: NSAccessibility.Attribute) {
        if attribute == .value {
            _ = apply(value)
            return
        }
        super.accessibilitySetValue(value, forAttribute: attribute)
    }

    override func accessibilityActionNames() -> [NSAccessibility.Action] {
        [.increment, .decrement]
    }

    override func accessibilityPerformAction(_ action: NSAccessibility.Action) {
        switch action {
        case .increment:
            _ = applyStep?(1)
        case .decrement:
            _ = applyStep?(-1)
        default:
            super.accessibilityPerformAction(action)
        }
    }

    override func isAccessibilitySelectorAllowed(_ selector: Selector) -> Bool {
        if selector == #selector(setAccessibilityValue(_:))
            || selector == #selector(accessibilityPerformIncrement)
            || selector == #selector(accessibilityPerformDecrement)
        {
            return true
        }
        return super.isAccessibilitySelectorAllowed(selector)
    }
}
